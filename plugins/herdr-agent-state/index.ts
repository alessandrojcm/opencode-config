// Reports OpenCode session and activity state to the enclosing Herdr pane.
//
// This is a local OpenCode V2 plugin. Do not replace it with Herdr's generated
// OpenCode integration: that integration imports the retired @opencode-ai scope.

import { Plugin } from "@opencode/plugin/effect";
import { Effect, Predicate, Stream } from "effect";
import { makeTransport } from "../herdr-worktrees/herdr.ts";

const SOURCE = "herdr:opencode";
const AGENT = "opencode";
let reportSeq = Date.now() * 1_000;
let requestChain = Promise.resolve();
let reportedRootSessionID: string | undefined;

// Track child sessions so their events cannot replace the pane's root session.
// Their prompts still project activity state without attaching the child ID.
const childSessions = new Set<string>();
const CHILD_EVENT_STATES = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function stringField(value: unknown, field: string) {
  if (!isRecord(value)) return undefined;
  const candidate = value[field];
  return Predicate.isString(candidate) && candidate ? candidate : undefined;
}

function recordField(value: unknown, field: string): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[field];
  return isRecord(candidate) ? candidate : undefined;
}

function sessionIDFromEvent(event: { data?: unknown }) {
  const data = event.data;
  return stringField(data, "sessionID") ??
    stringField(data, "id") ??
    stringField(recordField(data, "info"), "id");
}

const SESSION_STATE_BY_STATUS = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["pending", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["streaming", "working"],
  ["working", "working"],
]);

function stateFromSessionStatus(status: unknown) {
  const kind = Predicate.isString(status) ? status : stringField(status, "type");
  return kind ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase()) : undefined;
}

function request(method: string, params: Record<string, unknown>) {
  const pending = requestChain.then(() => requestOnce(method, params));
  requestChain = pending.catch(() => {});
  return pending;
}

function requestOnce(method: string, params: Record<string, unknown>) {
  const paneId = Bun.env.HERDR_PANE_ID;
  const socketPath = Bun.env.HERDR_SOCKET_PATH;

  if (!paneId || !socketPath) return Promise.resolve();

  const request = {
    pane_id: paneId,
    source: SOURCE,
    agent: AGENT,
    seq: nextReportSeq(),
    ...params,
  };

  return makeTransport(socketPath, SOURCE)
    .request(method, request, 500)
    .then(() => undefined)
    .catch(() => undefined);
}

function reportSession(sessionID: string | undefined, sessionStartSource?: string) {
  if (!sessionID) return Promise.resolve();
  const params: Record<string, string> = { agent_session_id: sessionID };
  if (sessionStartSource) params.session_start_source = sessionStartSource;
  return request("pane.report_agent_session", params);
}

function reportState(state: string, sessionID?: string) {
  const params: Record<string, string> = { state };
  if (sessionID) {
    reportedRootSessionID = sessionID;
    params.agent_session_id = sessionID;
  }
  return request("pane.report_agent", params);
}

const report = Effect.fn("herdr.report")(function* (operation: () => Promise<void>) {
  yield* Effect.tryPromise({
    try: operation,
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void));
});

const handleEvent = Effect.fn("herdr.handleEvent")(function* (event: { type: string; data?: unknown }) {
  const { type, data } = event;
  const sessionID = sessionIDFromEvent(event);
  const info = recordField(data, "info");
  const childSessionID = stringField(info, "id");

  if (childSessionID && stringField(info, "parentID")) childSessions.add(childSessionID);
  if (sessionID && childSessions.has(sessionID)) {
    const state = CHILD_EVENT_STATES.get(type);
    if (state) yield* report(() => reportState(state));
    return;
  }

  switch (type) {
    case "session.created":
      yield* report(() => reportSession(sessionID, "new"));
      return;
    case "session.updated":
      if (sessionID && sessionID !== reportedRootSessionID) yield* report(() => reportSession(sessionID));
      return;
    case "session.status": {
      const state = stateFromSessionStatus(stringField(data, "status") ?? recordField(data, "status"));
      yield* report(() => state ? reportState(state, sessionID) : reportSession(sessionID));
      return;
    }
    case "tool.execute.before":
    case "tool.execute.after":
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
    case "session.compacted":
      yield* report(() => reportState("working", sessionID));
      return;
    case "permission.asked":
    case "question.asked":
    case "session.error":
      yield* report(() => reportState("blocked", sessionID));
      return;
    case "session.idle":
      yield* report(() => reportState("idle", sessionID));
  }
});

export default Plugin.define({
  id: "herdr-agent-state",
  effect: (ctx) =>
    Effect.gen(function* () {
      if (Bun.env.HERDR_ENV !== "1" || !Bun.env.HERDR_SOCKET_PATH || !Bun.env.HERDR_PANE_ID) return;

      yield* ctx.event.subscribe().pipe(
        Stream.runForEach(handleEvent),
        Effect.forkScoped,
      );
    }),
});
