import { describe, expect, test } from "bun:test";
import { detect, hashInput, summarizeInput, type RuleContext } from "./rules.ts";
import type { ToolCallRow, TurnRow } from "./db.ts";

function turn(over: Partial<TurnRow> = {}): TurnRow {
  return {
    id: "t1",
    session_id: "s1",
    idx: 0,
    started: 0,
    ended: 1000,
    outcome: "succeeded",
    steps: 1,
    tool_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_reasoning: 0,
    cost: 0,
    permission_wait_ms: 0,
    retries: 0,
    compactions: 0,
    ...over,
  };
}

let seq = 0;
function call(over: Partial<ToolCallRow> & { tool: string }): ToolCallRow {
  seq++;
  return {
    id: `c${seq}`,
    turn_id: "t1",
    seq,
    input_hash: over.input_hash ?? `h${seq}`,
    input_summary: over.input_summary ?? "",
    duration_ms: 1,
    status: "completed",
    error: null,
    ...over,
  };
}

const baseCtx: RuleContext = { agentP90: undefined, availableTools: new Set(["shell", "read", "grep", "glob", "astgrep_pattern"]) };

function types(t: TurnRow, calls: ToolCallRow[], ctx: RuleContext = baseCtx) {
  return detect(t, calls, ctx).map((f) => f.type);
}

describe("rules", () => {
  test("clean turn yields nothing", () => {
    expect(types(turn(), [call({ tool: "read" })])).toEqual([]);
  });

  test("flailing: same tool + same hash ≥ 3", () => {
    const calls = [1, 2, 3].map(() => call({ tool: "read", input_hash: "same" }));
    const f = detect(turn({ tool_calls: 3 }), calls, baseCtx);
    expect(f.map((x) => x.type)).toEqual(["flailing"]);
    expect(f[0]!.evidence).toContain("read");
  });

  test("flailing threshold is exclusive below 3", () => {
    const calls = [1, 2].map(() => call({ tool: "read", input_hash: "same" }));
    expect(types(turn(), calls)).toEqual([]);
  });

  test("blind_retry: shell error followed by identical shell input", () => {
    const calls = [
      call({ tool: "shell", input_hash: "cmd", status: "error", error: "exit 1", input_summary: "make" }),
      call({ tool: "shell", input_hash: "cmd", input_summary: "make" }),
    ];
    expect(types(turn(), calls)).toEqual(["blind_retry"]);
  });

  test("blind_retry looks at the next shell call even with other tools in between", () => {
    const calls = [
      call({ tool: "shell", input_hash: "cmd", status: "error", error: "exit 1" }),
      call({ tool: "read", input_hash: "r" }),
      call({ tool: "shell", input_hash: "cmd" }),
    ];
    expect(types(turn(), calls)).toEqual(["blind_retry"]);
  });

  test("blind_retry ignores a different next command", () => {
    const calls = [
      call({ tool: "shell", input_hash: "a", status: "error", error: "exit 1" }),
      call({ tool: "shell", input_hash: "b" }),
    ];
    expect(types(turn(), calls)).toEqual([]);
  });

  test("tool_storm uses max(20, p90)", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => call({ tool: "read", input_hash: `h${i}` }));
    expect(types(turn({ tool_calls: 20 }), many(20))).toEqual([]);
    expect(types(turn({ tool_calls: 21 }), many(21))).toEqual(["tool_storm"]);
    expect(types(turn({ tool_calls: 21 }), many(21), { ...baseCtx, agentP90: 30 })).toEqual([]);
    expect(types(turn({ tool_calls: 31 }), many(31), { ...baseCtx, agentP90: 30 })).toEqual(["tool_storm"]);
  });

  test("blocked on permission wait > 60s", () => {
    expect(types(turn({ permission_wait_ms: 60_000 }), [])).toEqual([]);
    expect(types(turn({ permission_wait_ms: 60_001 }), [])).toEqual(["blocked"]);
  });

  test("interrupted outcome", () => {
    expect(types(turn({ outcome: "interrupted" }), [])).toEqual(["interrupted"]);
  });

  test("provider_retry is low severity and tagged not-harness", () => {
    const f = detect(turn({ retries: 2 }), [], baseCtx);
    expect(f).toHaveLength(1);
    expect(f[0]!.type).toBe("provider_retry");
    expect(f[0]!.severity).toBe("low");
    expect(f[0]!.fixTarget).toBe("none");
  });

  test("compaction", () => {
    expect(types(turn({ compactions: 1 }), [])).toEqual(["compaction"]);
  });

  test("shell_for_search when dedicated tools exist", () => {
    const calls = [call({ tool: "shell", input_summary: "rg foo src/" })];
    expect(types(turn(), calls)).toEqual(["shell_for_search"]);
    expect(types(turn(), calls, { agentP90: undefined, availableTools: new Set(["shell"]) })).toEqual([]);
  });

  test("shell_for_search does not fire on unrelated words", () => {
    const calls = [call({ tool: "shell", input_summary: "git grep-alike --nope; findings.txt" })];
    expect(types(turn(), calls)).toEqual([]);
  });

  test("shell_for_search reports once per turn", () => {
    const calls = [call({ tool: "shell", input_summary: "rg a" }), call({ tool: "shell", input_summary: "grep b" })];
    expect(types(turn(), calls)).toEqual(["shell_for_search"]);
  });
});

describe("hashInput / summarizeInput", () => {
  test("hash is stable across key order", () => {
    expect(hashInput({ a: 1, b: [1, 2] })).toBe(hashInput({ b: [1, 2], a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  test("summary prefers command/path-like fields and truncates", () => {
    expect(summarizeInput("shell", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeInput("read", { path: "/x/y.ts", offset: 1 })).toBe("/x/y.ts");
    expect(summarizeInput("other", { a: "x".repeat(3000) }).length).toBeLessThanOrEqual(1000);
    expect(summarizeInput("other", "raw")).toBe("raw");
  });
});
