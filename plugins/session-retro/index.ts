import { Plugin } from "@opencode/plugin/effect";
import type { Session } from "@opencode/schema/session";
import { Cause, Effect, FiberMap, Schema, Stream } from "effect";
import { buildPrompt, compressTranscript, parseAnalysis, type ContextMessage, type RuleHint } from "./analyze.ts";
import { openDb, type Db, type Outcome } from "./db.ts";
import { SessionRetro, type DueEvent, type PendingSession, type Policy } from "./rpc.ts";
import { formatRetroReport, type ReportFinding } from "./report.ts";
import { detect, hashInput, summarizeInput } from "./rules.ts";

type Options = {
  idleMinutes?: number;
  /** Model for the LLM pass. Falls back to the session's own model, then the catalog default. */
  analysisModel?: { providerID: string; id: string };
  /** Upper bound for one analysis call, in seconds (default 180). */
  analysisTimeoutSeconds?: number;
  includeSubagents?: boolean;
  dbPath?: string | null;
  /**
   * Path to a custom analysis prompt template. `{{transcript}}` and `{{hints}}` are substituted;
   * the JSON output-shape instructions are always appended so the parser and prompt stay in sync.
   */
  analysisPromptPath?: string | null;
};

type SessionState = {
  turnId?: string;
  toolStart: Map<string, number>;
  permissionAsk: Map<string, number>;
  agent?: string;
};

type PendingRecord = { title: string; projectDir: string; dueAt: number };
type EventData = {
  sessionID: string;
  parentID?: string;
  location?: { directory?: string };
  agent?: string;
  model?: { providerID: string; id: string };
  title?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
};
type RetroEvent = { type: string; location?: { directory: string }; data: EventData };

const PENDING_PREFIX = "pending/";

function defaultDbPath(): string {
  const xdg = Bun.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : `${Bun.env.HOME ?? "."}/.local/share`;
  return `${base.replace(/\/+$/, "")}/opencode/session-retro.db`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return Schema.is(Schema.String)(cause) ? cause : JSON.stringify(cause);
}

const QueryInput = Schema.Struct({
  sql: Schema.String.annotate({
    description: "A single read-only SELECT or WITH statement against retro.db. Tables: session, turn, tool_call, friction, retro_run, policy. Views: v_worst_sessions, v_tool_error_rates, v_friction_by_type, v_harness_fixes.",
  }),
});

const SummaryInput = Schema.Struct({
  sessionID: Schema.optional(Schema.String).annotate({ description: "Session to summarise. Defaults to the calling session." }),
});

const ContextInput = Schema.Struct({
  runID: Schema.String.annotate({ description: "Retro run ID shown in an exported session-retro Markdown report." }),
});

export default Plugin.define({
  id: "session-retro",
  effect: (ctx) =>
    Effect.gen(function* () {
      // SAFETY: OpenCode validates plugin options from opencode.json before plugin setup.
      const options = ctx.options as Options;
      const isNumber = Schema.is(Schema.Number);
      const idleMinutes = isNumber(options.idleMinutes) && options.idleMinutes > 0 ? options.idleMinutes : 30;
      const idleMs = idleMinutes * 60_000;
      const includeSubagents = options.includeSubagents !== false;
      const analysisTimeoutMs =
        (isNumber(options.analysisTimeoutSeconds) && options.analysisTimeoutSeconds > 0 ? options.analysisTimeoutSeconds : 180) * 1000;
      const dbPath = options.dbPath && options.dbPath.length > 0 ? options.dbPath : defaultDbPath();

      const db: Db = yield* Effect.acquireRelease(
        Effect.promise(() => openDb(dbPath)),
        (d) => Effect.sync(() => d.close()),
      );

      // Custom prompt template, read once at startup; a missing/unreadable file falls back to the default.
      const promptTemplate: string | undefined = yield* Effect.gen(function* () {
        const p = options.analysisPromptPath;
        if (!p || p.length === 0) return undefined;
        const text = yield* Effect.tryPromise(() => Bun.file(p).text());
        return text;
      }).pipe(
        Effect.catch((e) => Effect.logWarning(`session-retro: analysisPromptPath unreadable, using default prompt`, errorMessage(e)).pipe(Effect.as(undefined))),
      );

      const here = ctx.location.directory;
      const state = new Map<string, SessionState>();
      const ignored = new Set<string>(); // subagent sessions when includeSubagents=false
      const timers = yield* FiberMap.make<string>();
      const running = new Set<string>(); // sessions with an in-flight analysis
      // Effective tool ids visible to agents; refreshed whenever the tool registry is rebuilt.
      const knownTools = new Set<string>();

      const stateFor = (sessionID: string): SessionState => {
        let s = state.get(sessionID);
        if (!s) {
          s = { toolStart: new Map(), permissionAsk: new Map() };
          state.set(sessionID, s);
        }
        return s;
      };

      /** Cached open turn for a session, validated against the DB so external edits cannot leave a dangling id. */
      const liveTurn = (sessionID: string): string | undefined => {
        const s = stateFor(sessionID);
        if (s.turnId && db.turn(s.turnId)?.ended === null) return s.turnId;
        s.turnId = db.currentTurn(sessionID);
        return s.turnId;
      };

      const swallow =
        (label: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
          effect.pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`session-retro: ${label} failed`, Cause.pretty(cause)),
            ),
          );
      // SAFETY: Session.ID is a branded string and OpenCode session ids are passed through unchanged.
      const sid = (id: string) => id as Session.ID;

      // ---------- session bookkeeping ----------

      const ensureSession = Effect.fn("retro.ensureSession")(function* (sessionID: string) {
        const known = db.session(sessionID);
        if (known) {
          if (!includeSubagents && known.parent_id) {
            ignored.add(sessionID);
            return false;
          }
          return true;
        }
        const info = yield* ctx.session.get({ sessionID: sid(sessionID) }).pipe(Effect.option);
        if (info._tag === "None") return false;
        const s = info.value;
        if (!includeSubagents && s.parentID) {
          ignored.add(sessionID);
          return false;
        }
        db.upsertSession({
          id: s.id,
          parentId: s.parentID ?? null,
          projectDir: s.location.directory,
          agent: s.agent ?? null,
          model: s.model ? `${s.model.providerID}/${s.model.id}` : null,
          title: s.title ?? null,
          now: Date.now(),
        });
        stateFor(sessionID).agent = s.agent;
        return true;
      });

      const tracked = (sessionID: string) => {
        if (ignored.has(sessionID)) return false;
        const row = db.session(sessionID);
        return row === undefined || row.project_dir === here;
      };

      // ---------- pending / policy in storage ----------

      const setPending = (sessionID: string, record: PendingRecord) => ctx.storage.set(`${PENDING_PREFIX}${sessionID}`, record);
      const clearPending = (sessionID: string) => ctx.storage.remove(`${PENDING_PREFIX}${sessionID}`);
      const getPending = (sessionID: string) =>
        ctx.storage.get(`${PENDING_PREFIX}${sessionID}`).pipe(
          Effect.map((value) => {
            // SAFETY: these records are only written above by setPending with the PendingRecord contract.
            return (value as PendingRecord | undefined) ?? undefined;
          }),
        );

      const listPending = Effect.gen(function* () {
        const out: PendingSession[] = [];
        let after: string | undefined;
        do {
          const page = yield* ctx.storage.scan({ prefix: PENDING_PREFIX, after, limit: 200 });
          for (const entry of page.entries) {
            const sessionID = entry.key.slice(PENDING_PREFIX.length);
            // SAFETY: all entries under PENDING_PREFIX are written by setPending with this contract.
            const rec = entry.value as PendingRecord;
            out.push({
              sessionID,
              title: rec.title,
              projectDir: rec.projectDir,
              turns: db.turnsForSession(sessionID).length,
              dueAt: rec.dueAt,
            });
          }
          after = page.next;
        } while (after);
        return out;
      });

      const policyFor = (projectDir: string): Policy => db.policy(projectDir) ?? "ask";

      // ---------- analysis ----------

      const analyzeBody = Effect.fn("retro.analyze")(function* (sessionID: string, trigger: string) {
        yield* ensureSession(sessionID);
        // Only wait when we know the session is running; a bare wait on an idle session
        // can hang indefinitely in the current server build.
        const info = yield* ctx.session.get({ sessionID: sid(sessionID) });
        const isRunning = info.time.idle === undefined || (info.time.idle < info.time.updated && info.outcome === undefined);
        if (isRunning) {
          const waited = yield* ctx.session.wait({ sessionID: sid(sessionID) }).pipe(Effect.timeoutOption("10 minutes"));
          // Principle 3: never read session.context() while a turn is in flight.
          if (waited._tag === "None") return yield* Effect.fail(new Error("session is still running; retro not started"));
        }
        const messages = yield* ctx.session.context({ sessionID: sid(sessionID) });
        // SAFETY: session.context returns OpenCode context messages; transcript compression only consumes its documented variants.
        const transcript = compressTranscript(messages as ReadonlyArray<ContextMessage>);
        const turns = db.turnsForSession(sessionID);
        const turnIndex = new Map(turns.map((t) => [t.id, t.idx + 1]));
        const hints: RuleHint[] = db.ruleFrictionForSession(sessionID).map((f) => ({
          type: f.type,
          turn: f.turn_id ? (turnIndex.get(f.turn_id) ?? 0) : 0,
          evidence: f.evidence ?? "",
        }));
        const prompt = buildPrompt(transcript, hints, promptTemplate);
        // Prefer the configured analysis model, then the session's own model (the catalog default
        // may be a provider the user cannot reach outside the TUI).
        const modelRef = options.analysisModel
          ? ({ providerID: options.analysisModel.providerID, id: options.analysisModel.id } as const)
          : info.model
            ? ({ providerID: info.model.providerID, id: info.model.id } as const)
            : undefined;
        const modelLabel = modelRef ? `${modelRef.providerID}/${modelRef.id}` : "default";
        // SAFETY: modelRef comes from validated plugin options or the active OpenCode session model;
        // the SDK's generated model parameter is not exported by the Effect plugin facade.
        const generateInput = modelRef ? { prompt, model: modelRef as never } : { prompt };
        const result = yield* ctx.generate
          .text(generateInput)
          .pipe(
            Effect.timeoutOption(analysisTimeoutMs),
            Effect.flatMap((r) =>
              r._tag === "Some"
                ? Effect.succeed(r.value)
                : Effect.fail(new Error(`analysis model ${modelLabel} did not answer within ${Math.round(analysisTimeoutMs / 1000)}s`)),
            ),
          );
        const parsed = parseAnalysis(result.text);
        if (!parsed.ok) {
          const runID = db.insertRun({ sessionId: sessionID, trigger, model: modelLabel, status: "parse_error", rawOutput: result.text, summary: parsed.error });
          return { runID, findings: 0, summary: `Analysis output could not be parsed: ${parsed.error}` };
        }
        const runID = db.insertRun({ sessionId: sessionID, trigger, model: modelLabel, status: "ok", summary: parsed.value.summary, rawOutput: result.text });
        for (const f of parsed.value.findings) {
          const turn = turns[f.turn - 1];
          db.insertFriction({
            sessionId: sessionID,
            turnId: turn?.id ?? null,
            source: "llm",
            type: f.type,
            severity: f.severity,
            evidence: f.evidence,
            rootCause: f.root_cause,
            fixTarget: f.harness_fix.target,
            fixSuggestion: f.harness_fix.suggestion,
            runId: runID,
          });
        }
        return { runID, findings: parsed.value.findings.length, summary: parsed.value.summary, details: parsed.value.findings };
      });

      // One analysis per session at a time. `Effect.ensuring` (not try/finally inside the generator)
      // releases the guard on failure, timeout and interruption alike.
      const analyze = (sessionID: string, trigger: string) =>
        Effect.suspend(() => {
          if (running.has(sessionID)) return Effect.fail(new Error("analysis already running for this session"));
          running.add(sessionID);
          return analyzeBody(sessionID, trigger).pipe(Effect.ensuring(Effect.sync(() => running.delete(sessionID))));
        });

      const reportFor = (
        result: { runID: string; findings: number; summary: string; details?: ReadonlyArray<ReportFinding> },
        sessionID: string,
      ) => {
        const run = db.run(result.runID);
        if (!run) throw new Error(`retro run ${result.runID} was not persisted`);
        const rules = db.ruleFrictionForSession(sessionID);
        return formatRetroReport({
          findings: result.findings,
          summary: result.summary,
          details: result.details,
          run,
          session: db.session(sessionID),
          rules,
          dbPath,
        });
      };

      // ---------- idle timer ----------

      let emitDue: ((data: DueEvent) => Effect.Effect<void, unknown>) | undefined;

      const onIdleFired = Effect.fn("retro.idle")(function* (sessionID: string) {
        if (liveTurn(sessionID)) return;
        const session = db.session(sessionID);
        if (!session) return;
        const record: PendingRecord = { title: session.title ?? sessionID, projectDir: session.project_dir, dueAt: Date.now() };
        const policy = policyFor(session.project_dir);
        if (policy === "never") return;
        if (policy === "always") {
          yield* analyze(sessionID, "auto").pipe(swallow("auto analysis"));
          return;
        }
        yield* setPending(sessionID, record);
        if (emitDue) yield* emitDue({ sessionID, title: record.title, projectDir: record.projectDir, turns: db.turnsForSession(sessionID).length, idleMinutes }).pipe(swallow("emit due"));
      });

      const startIdleTimer = (sessionID: string) =>
        FiberMap.run(timers, sessionID, Effect.sleep(idleMs).pipe(Effect.andThen(onIdleFired(sessionID)), swallow("idle timer")));

      const cancelIdleTimer = (sessionID: string) => FiberMap.remove(timers, sessionID);

      // ---------- turn lifecycle ----------

      const onTurnStarted = Effect.fn("retro.turnStarted")(function* (sessionID: string) {
        if (!(yield* ensureSession(sessionID))) return;
        const s = stateFor(sessionID);
        s.turnId = db.openTurn(sessionID, Date.now());
        db.touchSession(sessionID, Date.now());
        yield* cancelIdleTimer(sessionID);
      });

      const flushPermissionWaits = (s: SessionState, turnId: string) => {
        const now = Date.now();
        for (const [, t0] of s.permissionAsk) db.addPermissionWait(turnId, now - t0);
        s.permissionAsk.clear();
      };

      const onTurnEnded = Effect.fn("retro.turnEnded")(function* (sessionID: string, outcome: Outcome) {
        if (!tracked(sessionID)) return;
        const s = stateFor(sessionID);
        const turnId = liveTurn(sessionID);
        if (!turnId) return;
        flushPermissionWaits(s, turnId);
        s.toolStart.clear();
        db.closeTurn(turnId, outcome, Date.now());
        s.turnId = undefined;

        const turn = db.turn(turnId);
        if (turn) {
          const calls = db.toolCalls(turnId);
          const tools = knownTools;
          const agent = s.agent ?? db.session(sessionID)?.agent ?? "";
          const findings = detect(turn, calls, { agentP90: agent ? db.toolCallsP90ForAgent(agent) : undefined, availableTools: tools });
          for (const f of findings) {
            db.insertFriction({ sessionId: sessionID, turnId, source: "rule", type: f.type, severity: f.severity, evidence: f.evidence, fixTarget: f.fixTarget });
          }
        }
        yield* startIdleTimer(sessionID);
      });

      // ---------- hooks ----------

      // Every hook is wrapped in `swallow`: a recording failure must never abort the agent's tool
      // call or permission evaluation (spec principle 2). An unwrapped throw here blocks every tool.
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.sync(() => {
          if (!tracked(event.sessionID)) return;
          stateFor(event.sessionID).toolStart.set(event.id, Date.now());
        }).pipe(swallow("tool.execute.before")),
      );

      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          if (!tracked(event.sessionID)) return;
          if (!(yield* ensureSession(event.sessionID))) return;
          const s = stateFor(event.sessionID);
          const t0 = s.toolStart.get(event.id);
          s.toolStart.delete(event.id);
          const turnId = liveTurn(event.sessionID) ?? db.openTurn(event.sessionID, t0 ?? Date.now());
          s.turnId = turnId;
          s.agent = event.agent;
          // SAFETY: OpenCode tool inputs are JSON-serializable values by the tool-call contract.
          const input = event.input as import("./rules.ts").JsonValue;
          db.insertToolCall({
            id: event.id,
            turnId,
            tool: event.tool,
            inputHash: hashInput(input),
            inputSummary: summarizeInput(event.tool, input),
            durationMs: t0 === undefined ? null : Date.now() - t0,
            status: event.status,
            error: event.status === "error" ? event.error.message : undefined,
          });
        }).pipe(swallow("tool.execute.after")),
      );

      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.sync(() => {
          if (event.effect !== "ask" || !tracked(event.sessionID)) return;
          const key = event.source?.type === "tool" ? event.source.id : `${event.action}:${event.resources.join(",")}`;
          stateFor(event.sessionID).permissionAsk.set(key, Date.now());
        }).pipe(swallow("permission.evaluate")),
      );

      // ---------- events ----------

      // The plugin is instantiated once per location and every instance sees the global event
      // stream. Only the instance whose location owns the session records it, so counters and
      // idle timers are not multiplied by the number of open projects.
      const ownsEvent = (event: RetroEvent): boolean => {
        const data = event.data;
        const dir = event.location?.directory ?? data?.location?.directory ?? (data?.sessionID ? db.session(data.sessionID)?.project_dir : undefined);
        return dir === undefined ? false : dir === here;
      };

      const handleEvent = (event: RetroEvent) =>
        Effect.gen(function* () {
          if (!ownsEvent(event)) return;
          const data = event.data;
          switch (event.type) {
            case "session.created": {
              if (!includeSubagents && data.parentID) {
                ignored.add(data.sessionID);
                return;
              }
              db.upsertSession({
                id: data.sessionID,
                parentId: data.parentID ?? null,
                projectDir: data.location?.directory ?? ctx.location.directory,
                agent: data.agent ?? null,
                model: data.model ? `${data.model.providerID}/${data.model.id}` : null,
                title: data.title ?? null,
                now: Date.now(),
              });
              if (data.agent) stateFor(data.sessionID).agent = data.agent;
              return;
            }
            case "session.renamed": {
              if (db.session(data.sessionID)) db.upsertSession({ id: data.sessionID, projectDir: db.session(data.sessionID)!.project_dir, title: data.title, now: Date.now() });
              return;
            }
            case "session.execution.started":
              return yield* onTurnStarted(data.sessionID);
            case "session.execution.succeeded":
              return yield* onTurnEnded(data.sessionID, "succeeded");
            case "session.execution.failed":
              return yield* onTurnEnded(data.sessionID, "failed");
            case "session.execution.interrupted":
              return yield* onTurnEnded(data.sessionID, "interrupted");
            case "session.retry.scheduled": {
              const t = liveTurn(data.sessionID);
              if (t) db.bumpTurn(t, "retries");
              return;
            }
            case "session.compaction.started": {
              const t = liveTurn(data.sessionID);
              if (t) db.bumpTurn(t, "compactions");
              return;
            }
            case "session.usage.recorded": {
              // Title/compaction usage attributed to the turn it happened in (no step increment).
              if (!tracked(data.sessionID)) return;
              const t = liveTurn(data.sessionID);
              if (t && data.tokens) {
                db.recordUsage(t, { tokensIn: data.tokens.input ?? 0, tokensOut: data.tokens.output ?? 0, tokensReasoning: data.tokens.reasoning ?? 0, cost: data.cost ?? 0 });
              }
              return;
            }
            case "session.step.ended": {
              if (!tracked(data.sessionID)) return;
              const t = liveTurn(data.sessionID);
              if (t && data.tokens) {
                db.recordStep(t, { tokensIn: data.tokens.input ?? 0, tokensOut: data.tokens.output ?? 0, tokensReasoning: data.tokens.reasoning ?? 0, cost: data.cost ?? 0 });
              }
              return;
            }
            case "permission.replied": {
              const s = state.get(data.sessionID);
              if (!s) return;
              // Requests are keyed by tool call id when sourced from a tool; fall back to flushing all.
              const turnId = liveTurn(data.sessionID);
              if (!turnId) return;
              const now = Date.now();
              for (const [k, t0] of s.permissionAsk) {
                db.addPermissionWait(turnId, now - t0);
                s.permissionAsk.delete(k);
              }
              return;
            }
            case "session.viewed": {
              const pending = yield* getPending(data.sessionID);
              if (pending && emitDue) {
                yield* emitDue({ sessionID: data.sessionID, title: pending.title, projectDir: pending.projectDir, turns: db.turnsForSession(data.sessionID).length, idleMinutes }).pipe(swallow("re-emit due"));
              }
              return;
            }
            case "session.deleted": {
              state.delete(data.sessionID);
              yield* cancelIdleTimer(data.sessionID);
              yield* clearPending(data.sessionID);
              return;
            }
          }
        }).pipe(swallow(`event ${event.type}`));

      yield* ctx.event
        .subscribe()
        .pipe(
          Stream.runForEach((event) => {
            // SAFETY: OpenCode emits documented event objects; the fields consumed by RetroEvent are event payload fields.
            return handleEvent(event as RetroEvent);
          }),
          swallow("event stream"),
          Effect.forkScoped,
        );

      // ---------- RPC ----------

      const registration = yield* ctx.rpc.register(SessionRetro, {
        run: (input, call) =>
          Effect.gen(function* () {
            // SAFETY: SessionRetro validates RPC input against the run schema.
            const { sessionID } = input as { sessionID: string };
            yield* cancelIdleTimer(sessionID);
            yield* clearPending(sessionID);
            const result = yield* analyze(sessionID, "manual").pipe(
              Effect.mapError((e) => call.error("analysis_failed", errorMessage(e), { message: errorMessage(e) })),
            );
            const run = db.run(result.runID);
            if (!run) {
              const message = `retro run ${result.runID} was not persisted`;
              return yield* Effect.fail(call.error("analysis_failed", message, { message }));
            }
            return { runID: result.runID, ranAt: run.ran_at, findings: result.findings, report: reportFor(result, sessionID) };
          }),
        skip: (input) =>
          Effect.gen(function* () {
            // SAFETY: SessionRetro validates RPC input against the skip schema.
            const { sessionID } = input as { sessionID: string };
            yield* cancelIdleTimer(sessionID);
            yield* clearPending(sessionID);
            return {};
          }),
        later: (input) =>
          Effect.gen(function* () {
            // SAFETY: SessionRetro validates RPC input against the later schema.
            const { sessionID } = input as { sessionID: string };
            yield* clearPending(sessionID);
            // A live turn already cancelled the previous timer; onTurnEnded starts the next one.
            if (!liveTurn(sessionID)) yield* startIdleTimer(sessionID);
            return {};
          }),
        policy: (input) =>
          Effect.sync(() => {
            // SAFETY: SessionRetro validates RPC input against the policy schema and enum.
            const { projectDir, policy } = input as { projectDir: string; policy: Policy };
            db.setPolicy(projectDir, policy);
            return {};
          }),
        pending: () => listPending.pipe(Effect.map((sessions) => ({ sessions }))),
        settings: (input) =>
          Effect.sync(() => {
            // SAFETY: SessionRetro validates RPC input against the settings schema.
            const { sessionID } = input as { sessionID: string };
            const projectDir = db.session(sessionID)?.project_dir ?? ctx.location.directory;
            return { projectDir, policy: policyFor(projectDir), idleMinutes, dbPath };
          }),
      }).pipe(Effect.orDie);
      emitDue = (data) => registration.events.emit("due", data);

      // ---------- tools ----------

      yield* ctx.tool.transform((draft) => {
        knownTools.clear();
        for (const t of draft.list()) knownTools.add(t.id);
        draft.add({
          name: "retro_query",
          description:
            "Run a read-only SQL SELECT against the session-retro SQLite database of turns, tool calls and friction findings. Useful for finding harness (AGENTS.md/skill/prompt/permission) improvements from data. Try `select * from v_harness_fixes limit 20`.",
          input: QueryInput,
          options: { namespace: "retro", codemode: true },
          execute: ({ sql }) =>
            Effect.gen(function* () {
              const ro = yield* Effect.promise(() => openDb(dbPath, { readonly: true }));
              try {
                const rows = ro.readonlyQuery(sql);
                return { content: JSON.stringify(rows, null, 2), metadata: { title: "retro query", rows: rows.length } };
              } catch (e) {
                return { content: `Query error: ${errorMessage(e)}`, metadata: { title: "retro query", error: true } };
              } finally {
                ro.close();
              }
            }),
        });

        draft.add({
          name: "retro_summary",
          description: "Return the latest session-retro run and its findings for a session (defaults to the current session).",
          input: SummaryInput,
          options: { namespace: "retro", codemode: true },
          execute: ({ sessionID }, tool) =>
            Effect.sync(() => {
              const id = sessionID ?? tool.sessionID;
              const run = db.latestRun(id);
              const rules = db.ruleFrictionForSession(id);
              const out = {
                sessionID: id,
                run: run ?? null,
                llmFindings: run ? db.frictionForRun(run.id) : [],
                ruleFindings: rules,
                turns: db.turnsForSession(id).length,
              };
              return { content: JSON.stringify(out, null, 2), metadata: { title: "retro summary", sessionID: id } };
            }),
        });

        draft.add({
          name: "retro_context",
          description:
            "Retrieve the recorded session, retro run, turns, summarized tool calls, and findings from the session-retro database using the run ID embedded in an exported Markdown report.",
          input: ContextInput,
          options: { namespace: "retro", codemode: true },
          execute: ({ runID }) =>
            Effect.sync(() => {
              const run = db.run(runID);
              if (!run) {
                return { content: `No retro run found for ${runID}`, metadata: { title: "retro context", runID, error: true } };
              }
              const session = db.session(run.session_id);
              const turns = db.turnsForSession(run.session_id).map((turn) => ({ ...turn, toolCalls: db.toolCalls(turn.id) }));
              const out = {
                run,
                session: session ?? null,
                turns,
                llmFindings: db.frictionForRun(run.id),
                ruleFindings: db.ruleFrictionForSession(run.session_id),
              };
              return { content: JSON.stringify(out, null, 2), metadata: { title: "retro context", runID, sessionID: run.session_id } };
            }),
        });
      });

      // On unload, flush in-memory permission waits and bump last_seen. Open turns are left open on
      // purpose: an unload is not an outcome, and closing them as "interrupted" would be a false signal.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const now = Date.now();
          for (const [sessionID, s] of state) {
            const turnId = liveTurn(sessionID);
            if (!turnId) continue;
            flushPermissionWaits(s, turnId);
            db.touchSession(sessionID, now);
          }
        }),
      );
    }),
});
