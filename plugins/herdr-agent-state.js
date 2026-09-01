// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=9

import { Plugin } from "@opencode-ai/plugin/effect";
import { Effect, Predicate, Stream } from "effect";
import net from "node:net";

const SOURCE = "herdr:opencode";
const AGENT = "opencode";
let reportSeq = Date.now() * 1000;
let requestChain = Promise.resolve();
let reportedRootSessionID;

// Track child sessions so their events cannot replace the pane's root session.
// Their user prompts still project state without attaching the child session id.
const childSessions = new Set();
const CHILD_EVENT_STATES = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function stringField(value, field) {
  if (!Predicate.isRecord(value)) return undefined;
  const candidate = value[field];
  return Predicate.isString(candidate) && candidate ? candidate : undefined;
}

function recordField(value, field) {
  if (!Predicate.isRecord(value)) return undefined;
  const candidate = value[field];
  return Predicate.isRecord(candidate) ? candidate : undefined;
}

function sessionIDFromEvent(event) {
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

function stateFromSessionStatus(status) {
  const kind = Predicate.isString(status) ? status : stringField(status, "type");
  return kind ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase()) : undefined;
}

function request(method, params) {
  const pending = requestChain.then(() => requestOnce(method, params));
  requestChain = pending.catch(() => {});
  return pending;
}

function requestOnce(method, params) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;

  if (!paneId || !socketPath) {
    return Promise.resolve();
  }

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  const requestId = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
  const request = {
    id: requestId,
    method,
    params: {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      seq: nextReportSeq(),
      ...params,
    },
  };

  return new Promise((resolve) => {
    const client = net.createConnection(socketEndpoint, () => {
      client.write(`${JSON.stringify(request)}\n`);
    });

    const finish = () => {
      client.destroy();
      resolve();
    };

    client.setTimeout(500, finish);
    client.on("data", finish);
    client.on("error", finish);
    client.on("end", finish);
    client.on("close", resolve);
  });
}

function reportSession(sessionID, sessionStartSource) {
  if (!sessionID) {
    return Promise.resolve();
  }
  const params = { agent_session_id: sessionID };
  if (sessionStartSource) {
    params.session_start_source = sessionStartSource;
  }
  return request("pane.report_agent_session", params);
}

function reportState(state, sessionID) {
  const params = { state };
  if (sessionID) {
    reportedRootSessionID = sessionID;
    params.agent_session_id = sessionID;
  }
  return request("pane.report_agent", params);
}

const report = Effect.fn("herdr.report")(function* (operation) {
  yield* Effect.tryPromise({
    try: operation,
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void));
});

const handleEvent = Effect.fn("herdr.handleEvent")(function* (event) {
  const type = event.type;
  const data = event.data;
  const sessionID = sessionIDFromEvent(event);
  const info = recordField(data, "info");

  if (stringField(info, "id") && stringField(info, "parentID")) {
    childSessions.add(stringField(info, "id"));
  }
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
      if (sessionID && sessionID !== reportedRootSessionID) {
        yield* report(() => reportSession(sessionID));
      }
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
      return;
  }
});

export default Plugin.define({
  id: "herdr-agent-state",
  effect: (ctx) =>
    Effect.gen(function* () {
      if (
        process.env.HERDR_ENV !== "1" ||
        !process.env.HERDR_SOCKET_PATH ||
        !process.env.HERDR_PANE_ID
      ) return;

      yield* ctx.event.subscribe().pipe(
        Stream.runForEach(handleEvent),
        Effect.forkScoped,
      );
    }),
});
