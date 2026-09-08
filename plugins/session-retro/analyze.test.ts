import { describe, expect, test } from "bun:test";
import { buildPrompt, compressTranscript, parseAnalysis } from "./analyze.ts";

const messages = [
  { id: "u1", type: "user", time: { created: 1 }, text: "please fix the build" },
  {
    id: "a1",
    type: "assistant",
    time: { created: 2 },
    agent: "build",
    model: { providerID: "p", id: "m" },
    finish: "tool-calls",
    content: [
      { type: "reasoning", text: "secret thinking" },
      { type: "text", text: "Looking." },
      {
        type: "tool",
        id: "c1",
        name: "shell",
        state: { status: "completed", input: { command: "make" }, content: [{ type: "text", text: "HUGE OUTPUT ".repeat(100) }] },
        time: { created: 3 },
      },
      {
        type: "tool",
        id: "c2",
        name: "read",
        state: { status: "error", input: { path: "/x" }, error: { type: "x", message: "nope" } },
        time: { created: 4 },
      },
    ],
  },
  { id: "u2", type: "user", time: { created: 5 }, text: "no, I said the *build*, not tests" },
  { id: "syn", type: "synthetic", time: { created: 6 }, text: "retro summary", metadata: { sessionRetro: true } },
  { id: "a2", type: "assistant", time: { created: 7 }, agent: "build", model: { providerID: "p", id: "m" }, finish: "stop", content: [{ type: "text", text: "Done." }] },
] as const;

describe("compressTranscript", () => {
  test("keeps user/assistant text and one line per tool, drops reasoning, outputs and retro messages", () => {
    const out = compressTranscript(messages as any);
    expect(out).toContain("[turn 1] USER: please fix the build");
    expect(out).toContain("ASSISTANT: Looking.");
    expect(out).toContain("#1 shell completed make");
    expect(out).toContain("#2 read error /x — nope");
    expect(out).toContain("[turn 2] USER: no, I said");
    expect(out).not.toContain("secret thinking");
    expect(out).not.toContain("HUGE OUTPUT");
    expect(out).not.toContain("retro summary");
  });
});

describe("buildPrompt", () => {
  test("includes transcript and rule hints and asks for JSON", () => {
    const p = buildPrompt("TRANSCRIPT", [{ type: "flailing", turn: 1, evidence: "x" }]);
    expect(p).toContain("TRANSCRIPT");
    expect(p).toContain("flailing");
    expect(p).toMatch(/JSON/);
  });
});

describe("parseAnalysis", () => {
  test("accepts valid JSON, including fenced", () => {
    const raw = '```json\n{"findings":[{"type":"user_correction","turn":2,"severity":"high","evidence":"e","root_cause":"r","harness_fix":{"target":"agents_md","suggestion":"s"}}],"summary":"ok"}\n```';
    const r = parseAnalysis(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings).toHaveLength(1);
      expect(r.value.summary).toBe("ok");
    }
  });

  test("rejects invalid JSON and bad shapes", () => {
    expect(parseAnalysis("not json").ok).toBe(false);
    expect(parseAnalysis('{"summary":"x"}').ok).toBe(false);
    expect(parseAnalysis('{"findings":[{"type":"nope","turn":1,"severity":"low","evidence":"","root_cause":"","harness_fix":{"target":"none","suggestion":""}}],"summary":""}').ok).toBe(false);
    expect(parseAnalysis('{"findings":[{"type":"other","turn":"1","severity":"low","evidence":"","root_cause":"","harness_fix":{"target":"none","suggestion":""}}],"summary":""}').ok).toBe(false);
  });

  test("accepts empty findings", () => {
    const r = parseAnalysis('{"findings":[],"summary":"clean"}');
    expect(r.ok).toBe(true);
  });
});

describe("compressTranscript budget", () => {
  test("drops oldest turns first and marks the omission", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, type: "user", time: { created: i }, text: `turn ${i + 1} ` + "x".repeat(400) }));
    const out = compressTranscript(msgs as any, 1200);
    expect(out).toMatch(/^\(\d earlier turns omitted/);
    expect(out).not.toContain("[turn 1]");
    expect(out).toContain("[turn 6]");
    expect(out.length).toBeLessThanOrEqual(1300);
  });
});
