import { Database } from "bun:sqlite";

export type Outcome = "succeeded" | "failed" | "interrupted";
export type Severity = "low" | "medium" | "high";
export type FrictionSource = "rule" | "llm";
export type FixTarget = "agents_md" | "skill" | "prompt" | "permission" | "plugin" | "tool" | "none";

export type SessionRow = {
  id: string;
  parent_id: string | null;
  project_dir: string;
  agent: string | null;
  model: string | null;
  title: string | null;
  first_seen: number;
  last_seen: number;
};

export type TurnRow = {
  id: string;
  session_id: string;
  idx: number;
  started: number;
  ended: number | null;
  outcome: Outcome | null;
  steps: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  cost: number;
  permission_wait_ms: number;
  retries: number;
  compactions: number;
};

export type ToolCallRow = {
  id: string;
  turn_id: string;
  seq: number;
  tool: string;
  input_hash: string;
  input_summary: string;
  duration_ms: number | null;
  status: "completed" | "error";
  error: string | null;
};

export type FrictionRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  source: FrictionSource;
  type: string;
  severity: Severity;
  evidence: string | null;
  root_cause: string | null;
  fix_target: FixTarget | null;
  fix_suggestion: string | null;
  run_id: string | null;
  created: number;
};

export type RunRow = {
  id: string;
  session_id: string;
  ran_at: number;
  trigger: string;
  model: string | null;
  tokens: number | null;
  status: string;
  summary: string | null;
  raw_output: string | null;
};

export type FrictionInput = {
  sessionId: string;
  turnId?: string | null;
  source: FrictionSource;
  type: string;
  severity: Severity;
  evidence?: string;
  rootCause?: string;
  fixTarget?: FixTarget;
  fixSuggestion?: string;
  runId?: string;
};

// Tables are additive (`if not exists`). Views are dropped and recreated on every migrate so that a
// changed view definition reaches existing databases; `create view if not exists` would silently
// keep the old one.
const SCHEMA = `
create table if not exists session (
  id text primary key,
  parent_id text,
  project_dir text not null,
  agent text,
  model text,
  title text,
  first_seen integer not null,
  last_seen integer not null
);
create table if not exists turn (
  id text primary key,
  session_id text not null references session(id),
  idx integer not null,
  started integer not null,
  ended integer,
  outcome text,
  steps integer not null default 0,
  tool_calls integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  tokens_reasoning integer not null default 0,
  cost real not null default 0,
  permission_wait_ms integer not null default 0,
  retries integer not null default 0,
  compactions integer not null default 0
);
create index if not exists turn_session_idx on turn(session_id, idx);
create table if not exists tool_call (
  id text primary key,
  turn_id text not null references turn(id),
  seq integer not null,
  tool text not null,
  input_hash text not null,
  input_summary text not null,
  duration_ms integer,
  status text not null,
  error text
);
create index if not exists tool_call_turn_idx on tool_call(turn_id, seq);
create table if not exists friction (
  id text primary key,
  session_id text not null,
  turn_id text,
  source text not null,
  type text not null,
  severity text not null,
  evidence text,
  root_cause text,
  fix_target text,
  fix_suggestion text,
  run_id text,
  created integer not null
);
create index if not exists friction_session_idx on friction(session_id);
create table if not exists retro_run (
  id text primary key,
  session_id text not null,
  ran_at integer not null,
  trigger text not null,
  model text,
  tokens integer,
  status text not null,
  summary text,
  raw_output text
);
create table if not exists policy (
  project_dir text primary key,
  policy text not null
);

drop view if exists v_worst_sessions;
create view v_worst_sessions as
select s.id, s.title, s.project_dir, s.agent,
       coalesce(t.turns, 0) as turns,
       coalesce(f.frictions, 0) as frictions,
       f.score as score,
       coalesce(t.interrupted_turns, 0) as interrupted_turns,
       s.last_seen
from session s
left join (
  select session_id,
         count(*) as turns,
         sum(case when outcome='interrupted' then 1 else 0 end) as interrupted_turns
  from turn group by session_id
) t on t.session_id = s.id
left join (
  select session_id,
         count(*) as frictions,
         sum(case severity when 'high' then 3 when 'medium' then 2 else 1 end) as score
  from friction group by session_id
) f on f.session_id = s.id
order by score desc nulls last, frictions desc;

drop view if exists v_tool_error_rates;
create view v_tool_error_rates as
select tool,
       count(*) as calls,
       sum(case when status='error' then 1 else 0 end) as errors,
       round(1.0 * sum(case when status='error' then 1 else 0 end) / count(*), 3) as error_rate,
       round(avg(duration_ms)) as avg_ms
from tool_call
group by tool
order by error_rate desc, calls desc;

drop view if exists v_friction_by_type;
create view v_friction_by_type as
select type, source,
       count(*) as n,
       sum(case severity when 'high' then 1 else 0 end) as high,
       sum(case severity when 'medium' then 1 else 0 end) as medium,
       sum(case severity when 'low' then 1 else 0 end) as low
from friction
group by type, source
order by n desc;

drop view if exists v_harness_fixes;
create view v_harness_fixes as
select f.fix_target, f.type, f.severity, f.fix_suggestion, f.root_cause, f.evidence,
       f.session_id, s.project_dir, s.title, f.created
from friction f
join session s on s.id = f.session_id
where f.fix_target is not null and f.fix_target <> 'none'
order by f.created desc;
`;

// First-keyword gate only. The retro_query connection is opened `readonly` with `query_only = on`,
// so SQLite itself rejects any write (including a CTE-wrapped `with x as (...) delete ...`);
// a keyword blocklist would only add false positives like `select replace(...)` or `where type = 'update'`.
const READONLY = /^\s*(select|with)\b/i;

let counter = 0;
function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export type Db = Awaited<ReturnType<typeof openDb>>;

/**
 * Bun has no native mkdir, but `Bun.write` creates missing parent directories. Writing an empty
 * file is safe for SQLite (a zero-byte file is a valid empty database) — but only when the file
 * does not already exist, otherwise the write would truncate a live database.
 */
async function ensureParentDir(path: string): Promise<void> {
  if (path === ":memory:") return;
  if (await Bun.file(path).exists()) return;
  await Bun.write(path, "");
}

export async function openDb(path: string, options: { readonly?: boolean } = {}) {
  if (!options.readonly) await ensureParentDir(path);
  const raw = options.readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { create: true });
  if (!options.readonly && path !== ":memory:") raw.exec("pragma journal_mode = wal");
  if (options.readonly) raw.exec("pragma query_only = on");
  raw.exec("pragma foreign_keys = on");

  const api = {
    raw,

    migrate() {
      raw.exec(SCHEMA);
    },

    close() {
      raw.close();
    },

    upsertSession(input: {
      id: string;
      parentId?: string | null;
      projectDir: string;
      agent?: string | null;
      model?: string | null;
      title?: string | null;
      now: number;
    }) {
      raw
        .query(
          `insert into session (id, parent_id, project_dir, agent, model, title, first_seen, last_seen)
           values ($id, $parent, $dir, $agent, $model, $title, $now, $now)
           on conflict(id) do update set
             parent_id = coalesce(excluded.parent_id, session.parent_id),
             project_dir = excluded.project_dir,
             agent = coalesce(excluded.agent, session.agent),
             model = coalesce(excluded.model, session.model),
             title = coalesce(excluded.title, session.title),
             last_seen = excluded.last_seen`,
        )
        .run({
          $id: input.id,
          $parent: input.parentId ?? null,
          $dir: input.projectDir,
          $agent: input.agent ?? null,
          $model: input.model ?? null,
          $title: input.title ?? null,
          $now: input.now,
        });
    },

    session(id: string): SessionRow | undefined {
      return raw.query<SessionRow, [string]>(`select * from session where id = ?`).get(id) ?? undefined;
    },

    touchSession(id: string, now: number) {
      raw.query(`update session set last_seen = ? where id = ?`).run(now, id);
    },

    currentTurn(sessionId: string): string | undefined {
      return raw
        .query<{ id: string }, [string]>(`select id from turn where session_id = ? and ended is null order by idx desc limit 1`)
        .get(sessionId)?.id;
    },

    openTurn(sessionId: string, now: number): string {
      const existing = api.currentTurn(sessionId);
      if (existing) return existing;
      const idx =
        raw.query<{ n: number }, [string]>(`select count(*) as n from turn where session_id = ?`).get(sessionId)?.n ?? 0;
      const id = newId("turn");
      raw
        .query(`insert into turn (id, session_id, idx, started) values (?, ?, ?, ?)`)
        .run(id, sessionId, idx, now);
      return id;
    },

    closeTurn(turnId: string, outcome: Outcome, now: number) {
      raw.query(`update turn set ended = ?, outcome = ? where id = ?`).run(now, outcome, turnId);
    },

    turn(id: string): TurnRow | undefined {
      return raw.query<TurnRow, [string]>(`select * from turn where id = ?`).get(id) ?? undefined;
    },

    turnsForSession(sessionId: string): TurnRow[] {
      return raw.query<TurnRow, [string]>(`select * from turn where session_id = ? order by idx`).all(sessionId);
    },

    bumpTurn(turnId: string, column: "retries" | "compactions") {
      raw.query(`update turn set ${column} = ${column} + 1 where id = ?`).run(turnId);
    },

    addPermissionWait(turnId: string, ms: number) {
      raw.query(`update turn set permission_wait_ms = permission_wait_ms + ? where id = ?`).run(Math.round(ms), turnId);
    },

    recordStep(turnId: string, step: { tokensIn: number; tokensOut: number; tokensReasoning: number; cost: number }) {
      raw
        .query(
          `update turn set steps = steps + 1,
             tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
             tokens_reasoning = tokens_reasoning + ?, cost = cost + ?
           where id = ?`,
        )
        .run(step.tokensIn, step.tokensOut, step.tokensReasoning, step.cost, turnId);
    },

    recordUsage(turnId: string, usage: { tokensIn: number; tokensOut: number; tokensReasoning: number; cost: number }) {
      raw
        .query(
          `update turn set tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
             tokens_reasoning = tokens_reasoning + ?, cost = cost + ?
           where id = ?`,
        )
        .run(usage.tokensIn, usage.tokensOut, usage.tokensReasoning, usage.cost, turnId);
    },

    insertToolCall(input: {
      id: string;
      turnId: string;
      tool: string;
      inputHash: string;
      inputSummary: string;
      durationMs: number | null;
      status: "completed" | "error";
      error?: string;
    }) {
      const seq =
        raw.query<{ n: number }, [string]>(`select count(*) as n from tool_call where turn_id = ?`).get(input.turnId)?.n ?? 0;
      raw
        .query(
          `insert or replace into tool_call (id, turn_id, seq, tool, input_hash, input_summary, duration_ms, status, error)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.turnId,
          seq,
          input.tool,
          input.inputHash,
          input.inputSummary,
          input.durationMs === null ? null : Math.round(input.durationMs),
          input.status,
          input.error ?? null,
        );
      raw.query(`update turn set tool_calls = tool_calls + 1 where id = ?`).run(input.turnId);
    },

    toolCalls(turnId: string): ToolCallRow[] {
      return raw.query<ToolCallRow, [string]>(`select * from tool_call where turn_id = ? order by seq`).all(turnId);
    },

    toolCallsP90ForAgent(agent: string): number | undefined {
      const rows = raw
        .query<{ n: number }, [string]>(
          `select t.tool_calls as n from turn t join session s on s.id = t.session_id
           where s.agent = ? and t.ended is not null order by n`,
        )
        .all(agent);
      if (rows.length === 0) return undefined;
      const idx = Math.min(rows.length - 1, Math.floor(rows.length * 0.9));
      return rows[idx]!.n;
    },

    insertFriction(input: FrictionInput): string {
      const id = newId("fr");
      raw
        .query(
          `insert into friction (id, session_id, turn_id, source, type, severity, evidence, root_cause, fix_target, fix_suggestion, run_id, created)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          input.turnId ?? null,
          input.source,
          input.type,
          input.severity,
          input.evidence ?? null,
          input.rootCause ?? null,
          input.fixTarget ?? null,
          input.fixSuggestion ?? null,
          input.runId ?? null,
          Date.now(),
        );
      return id;
    },

    frictionForSession(sessionId: string): FrictionRow[] {
      return raw.query<FrictionRow, [string]>(`select * from friction where session_id = ? order by created`).all(sessionId);
    },

    frictionForRun(runId: string): FrictionRow[] {
      return raw.query<FrictionRow, [string]>(`select * from friction where run_id = ? order by created`).all(runId);
    },

    ruleFrictionForSession(sessionId: string): FrictionRow[] {
      return raw
        .query<FrictionRow, [string]>(`select * from friction where session_id = ? and source = 'rule' order by created`)
        .all(sessionId);
    },

    insertRun(input: {
      sessionId: string;
      trigger: string;
      model?: string | null;
      tokens?: number | null;
      status: string;
      summary?: string | null;
      rawOutput?: string | null;
    }): string {
      const id = newId("run");
      raw
        .query(
          `insert into retro_run (id, session_id, ran_at, trigger, model, tokens, status, summary, raw_output)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          Date.now(),
          input.trigger,
          input.model ?? null,
          input.tokens ?? null,
          input.status,
          input.summary ?? null,
          input.rawOutput ?? null,
        );
      return id;
    },

    latestRun(sessionId: string): RunRow | undefined {
      return (
        raw
          .query<RunRow, [string]>(`select * from retro_run where session_id = ? order by ran_at desc limit 1`)
          .get(sessionId) ?? undefined
      );
    },

    run(id: string): RunRow | undefined {
      return raw.query<RunRow, [string]>(`select * from retro_run where id = ?`).get(id) ?? undefined;
    },

    setPolicy(projectDir: string, policy: "always" | "never" | "ask") {
      if (policy === "ask") {
        raw.query(`delete from policy where project_dir = ?`).run(projectDir);
        return;
      }
      raw
        .query(`insert into policy (project_dir, policy) values (?, ?) on conflict(project_dir) do update set policy = excluded.policy`)
        .run(projectDir, policy);
    },

    policy(projectDir: string): "always" | "never" | undefined {
      return (
        raw.query<{ policy: "always" | "never" }, [string]>(`select policy from policy where project_dir = ?`).get(projectDir)
          ?.policy ?? undefined
      );
    },

    readonlyQuery(sql: string): Record<string, unknown>[] {
      if (!READONLY.test(sql)) throw new Error("Only SELECT / WITH statements are allowed");
      if (sql.trim().replace(/;\s*$/, "").includes(";")) throw new Error("Only a single statement is allowed");
      return raw.query<Record<string, unknown>, []>(sql).all();
    },
  };

  // Readonly connections (retro_query) must not run DDL; the writer owns the schema.
  if (!options.readonly) api.migrate();
  return api;
}
