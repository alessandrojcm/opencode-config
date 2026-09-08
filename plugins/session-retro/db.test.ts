import { describe, expect, test } from "bun:test";
import { openDb } from "./db.ts";

function fresh() {
  return openDb(":memory:");
}

describe("db", () => {
  test("creates schema idempotently", () => {
    const db = fresh();
    db.migrate();
    db.migrate();
    const tables = db.raw
      .query<{ name: string }, []>(`select name from sqlite_master where type='table' order by name`)
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["session", "turn", "tool_call", "friction", "retro_run", "policy"]),
    );
  });

  test("session upsert keeps first_seen, bumps last_seen", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", title: "a", now: 100 });
    db.upsertSession({ id: "s1", projectDir: "/p", title: "b", now: 200 });
    const row = db.session("s1");
    expect(row?.first_seen).toBe(100);
    expect(row?.last_seen).toBe(200);
    expect(row?.title).toBe("b");
  });

  test("turn lifecycle: open, increment counters, close, index increments per session", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", now: 1 });
    const t1 = db.openTurn("s1", 10);
    db.bumpTurn(t1, "retries");
    db.bumpTurn(t1, "compactions");
    db.addPermissionWait(t1, 500);
    db.addPermissionWait(t1, 700);
    db.recordStep(t1, { tokensIn: 10, tokensOut: 5, tokensReasoning: 1, cost: 0.01 });
    db.recordStep(t1, { tokensIn: 10, tokensOut: 5, tokensReasoning: 1, cost: 0.01 });
    db.closeTurn(t1, "succeeded", 20);
    const t2 = db.openTurn("s1", 30);
    const a = db.turn(t1)!;
    const b = db.turn(t2)!;
    expect(a.idx).toBe(0);
    expect(b.idx).toBe(1);
    expect(a.retries).toBe(1);
    expect(a.compactions).toBe(1);
    expect(a.permission_wait_ms).toBe(1200);
    expect(a.steps).toBe(2);
    expect(a.tokens_in).toBe(20);
    expect(a.cost).toBeCloseTo(0.02);
    expect(a.outcome).toBe("succeeded");
    expect(a.ended).toBe(20);
  });

  test("tool calls attach to turn and bump tool_calls counter", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", now: 1 });
    const t = db.openTurn("s1", 10);
    db.insertToolCall({
      id: "c1",
      turnId: t,
      tool: "shell",
      inputHash: "h",
      inputSummary: "ls",
      durationMs: 12,
      status: "completed",
    });
    db.insertToolCall({
      id: "c2",
      turnId: t,
      tool: "shell",
      inputHash: "h",
      inputSummary: "ls",
      durationMs: 3,
      status: "error",
      error: "boom",
    });
    expect(db.turn(t)?.tool_calls).toBe(2);
    expect(db.toolCalls(t).map((c) => c.status)).toEqual(["completed", "error"]);
  });

  test("openTurn returns the existing open turn for a session", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", now: 1 });
    const t = db.openTurn("s1", 10);
    expect(db.openTurn("s1", 11)).toBe(t);
    expect(db.currentTurn("s1")).toBe(t);
  });

  test("p90 tool calls per agent over closed turns", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", agent: "build", now: 1 });
    for (let i = 0; i < 10; i++) {
      const t = db.openTurn("s1", i);
      for (let j = 0; j <= i; j++) {
        db.insertToolCall({ id: `c${i}-${j}`, turnId: t, tool: "read", inputHash: "x", inputSummary: "", durationMs: 1, status: "completed" });
      }
      db.closeTurn(t, "succeeded", i + 1);
    }
    // turns have 1..10 calls; index floor(10 * 0.9) = 9 → value 10
    expect(db.toolCallsP90ForAgent("build")).toBe(10);
    expect(db.toolCallsP90ForAgent("nobody")).toBeUndefined();
  });

  test("friction, retro_run and policy round-trip", () => {
    const db = fresh();
    db.upsertSession({ id: "s1", projectDir: "/p", now: 1 });
    const t = db.openTurn("s1", 10);
    db.closeTurn(t, "interrupted", 20);
    db.insertFriction({ sessionId: "s1", turnId: t, source: "rule", type: "interrupted", severity: "medium", evidence: "x" });
    const run = db.insertRun({ sessionId: "s1", trigger: "manual", model: "m", status: "ok", summary: "s", tokens: 1 });
    db.insertFriction({ sessionId: "s1", turnId: t, source: "llm", type: "user_correction", severity: "high", evidence: "e", rootCause: "r", fixTarget: "agents_md", fixSuggestion: "do x", runId: run });
    expect(db.frictionForSession("s1")).toHaveLength(2);
    expect(db.latestRun("s1")?.id).toBe(run);
    expect(db.frictionForRun(run)).toHaveLength(1);

    db.setPolicy("/p", "always");
    expect(db.policy("/p")).toBe("always");
    db.setPolicy("/p", "ask");
    expect(db.policy("/p")).toBeUndefined();
  });

  test("readonly query rejects non-select", () => {
    const db = fresh();
    expect(() => db.readonlyQuery("delete from session")).toThrow(/SELECT/);
    expect(db.readonlyQuery("select 1 as one")).toEqual([{ one: 1 }]);
    expect(db.readonlyQuery("with x as (select 2 as two) select * from x")).toEqual([{ two: 2 }]);
  });

  test("views exist", () => {
    const db = fresh();
    for (const v of ["v_worst_sessions", "v_tool_error_rates", "v_friction_by_type", "v_harness_fixes"]) {
      expect(() => db.readonlyQuery(`select * from ${v}`)).not.toThrow();
    }
  });
});

describe("db readonly hardening", () => {
  test("rejects CTE-wrapped writes and multiple statements", () => {
    const db = openDb(":memory:");
    expect(() => db.readonlyQuery("with x as (select 1) delete from session")).toThrow(/write keyword/);
    expect(() => db.readonlyQuery("select 1; select 2")).toThrow(/single statement/);
    expect(db.readonlyQuery("select 1 as a;")).toEqual([{ a: 1 }]);
  });
});
