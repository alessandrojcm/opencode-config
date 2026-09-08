import type { FixTarget, Severity } from "./db.ts";
import { summarizeInput } from "./rules.ts";

export const FINDING_TYPES = [
  "user_correction",
  "unnecessary_question",
  "false_done",
  "instruction_violated",
  "wrong_tool",
  "scope_creep",
  "other",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

const SEVERITIES: readonly Severity[] = ["low", "medium", "high"];
const TARGETS: readonly FixTarget[] = ["agents_md", "skill", "prompt", "permission", "plugin", "tool", "none"];

export type LlmFinding = {
  type: FindingType;
  turn: number;
  severity: Severity;
  evidence: string;
  root_cause: string;
  harness_fix: { target: FixTarget; suggestion: string };
};

export type Analysis = { findings: LlmFinding[]; summary: string };

export type RuleHint = { type: string; turn: number; evidence: string };

/** Marker on synthetic messages posted by this plugin so they are excluded from analysis. */
export const RETRO_METADATA_KEY = "sessionRetro";

// Loose structural types for what session.context() returns; we only read these fields.
type ToolContent = {
  type: "tool";
  id: string;
  name: string;
  state: { status: string; input?: unknown; error?: { message?: string } };
};
type AssistantContent = { type: "text"; text: string } | { type: "reasoning"; text: string } | ToolContent;
export type ContextMessage =
  | { type: "user"; text: string; metadata?: Record<string, unknown> }
  | { type: "assistant"; content: AssistantContent[]; finish?: string; error?: { type?: string; message?: string } }
  | { type: "synthetic"; text: string; metadata?: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

const MAX_TEXT = 1500;
/** Total transcript budget; older turns are dropped first so the most recent context survives. */
export const MAX_TRANSCRIPT_CHARS = 80_000;

function clip(text: string, max = MAX_TEXT): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function compressTranscript(messages: ReadonlyArray<ContextMessage>, budget = MAX_TRANSCRIPT_CHARS): string {
  const lines = transcriptLines(messages);
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= budget) return lines.join("\n");
  // Drop whole turns from the front until we fit, then prepend a marker.
  let dropped = 0;
  let cut = 0;
  while (total > budget && cut < lines.length) {
    const next = lines.findIndex((l, i) => i > cut && l.startsWith("[turn "));
    if (next === -1) break;
    for (let i = cut; i < next; i++) total -= lines[i]!.length + 1;
    cut = next;
    dropped++;
  }
  return [`(${dropped} earlier turn${dropped === 1 ? "" : "s"} omitted to fit the analysis budget)`, ...lines.slice(cut)].join("\n");
}

function transcriptLines(messages: ReadonlyArray<ContextMessage>): string[] {
  const lines: string[] = [];
  let turn = 0;
  let call = 0;
  for (const m of messages) {
    if (m.type === "synthetic") {
      const meta = (m as { metadata?: Record<string, unknown> }).metadata;
      if (meta?.[RETRO_METADATA_KEY]) continue;
      lines.push(`SYSTEM(synthetic): ${clip(String((m as { text: string }).text))}`);
      continue;
    }
    if (m.type === "user") {
      turn++;
      call = 0;
      lines.push(`[turn ${turn}] USER: ${clip((m as { text: string }).text)}`);
      continue;
    }
    if (m.type === "assistant") {
      const a = m as Extract<ContextMessage, { type: "assistant" }>;
      for (const c of a.content ?? []) {
        if (c.type === "text" && c.text.trim()) lines.push(`ASSISTANT: ${clip(c.text)}`);
        else if (c.type === "tool") {
          call++;
          const summary = summarizeInput(c.name, c.state?.input);
          const err = c.state?.status === "error" && c.state.error?.message ? ` — ${clip(c.state.error.message, 200)}` : "";
          lines.push(`  #${call} ${c.name} ${c.state?.status ?? "unknown"} ${summary}${err}`);
        }
      }
      if (a.finish === "error" && a.error) lines.push(`  (step ended with error: ${a.error.type ?? ""} ${clip(a.error.message ?? "", 200)})`);
    }
  }
  return lines;
}

export function buildPrompt(transcript: string, hints: RuleHint[]): string {
  const hintBlock =
    hints.length === 0
      ? "(no deterministic findings)"
      : hints.map((h) => `- turn ${h.turn}: ${h.type} — ${h.evidence}`).join("\n");
  return `You are reviewing a transcript of a coding-agent session to find friction that a better "harness"
(AGENTS.md instructions, skills, prompts, permission rules, plugins, tool descriptions) could have prevented.

Transcript format: "[turn N] USER:" lines are user messages; "ASSISTANT:" lines are assistant text; indented
"#k tool status input" lines are tool calls (outputs omitted).

Look for:
- user_correction: the user had to correct or redirect the agent
- unnecessary_question: the agent asked something it could have determined itself
- false_done: the agent claimed completion but the user found it incomplete/broken
- instruction_violated: the agent ignored an explicit instruction or convention
- wrong_tool: a clearly better tool existed for what the agent did
- scope_creep: the agent did work that was not asked for
- other

Deterministic findings already detected (use as hints, do not merely repeat them):
${hintBlock}

Transcript:
"""
${transcript}
"""

Respond with JSON only, no prose, matching exactly:
{"findings":[{"type":"user_correction|unnecessary_question|false_done|instruction_violated|wrong_tool|scope_creep|other",
  "turn":3,"severity":"low|medium|high","evidence":"…","root_cause":"…",
  "harness_fix":{"target":"agents_md|skill|prompt|permission|plugin|tool|none","suggestion":"…"}}],
 "summary":"one or two sentences"}

Only report findings with concrete evidence from the transcript. An empty findings array is a valid answer.`;
}

export type ParseResult = { ok: true; value: Analysis } | { ok: false; error: string };

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1]!.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function parseAnalysis(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "root is not an object" };
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return { ok: false, error: "findings is not an array" };
  if (!isString(obj.summary)) return { ok: false, error: "summary is not a string" };
  const findings: LlmFinding[] = [];
  for (const [i, f] of obj.findings.entries()) {
    if (!f || typeof f !== "object") return { ok: false, error: `findings[${i}] is not an object` };
    const x = f as Record<string, unknown>;
    if (!FINDING_TYPES.includes(x.type as FindingType)) return { ok: false, error: `findings[${i}].type invalid: ${String(x.type)}` };
    if (typeof x.turn !== "number" || !Number.isInteger(x.turn) || x.turn < 0) return { ok: false, error: `findings[${i}].turn not a non-negative integer` };
    if (!SEVERITIES.includes(x.severity as Severity)) return { ok: false, error: `findings[${i}].severity invalid` };
    if (!isString(x.evidence) || !isString(x.root_cause)) return { ok: false, error: `findings[${i}] evidence/root_cause not strings` };
    const fix = x.harness_fix as Record<string, unknown> | undefined;
    if (!fix || typeof fix !== "object") return { ok: false, error: `findings[${i}].harness_fix missing` };
    if (!TARGETS.includes(fix.target as FixTarget)) return { ok: false, error: `findings[${i}].harness_fix.target invalid` };
    if (!isString(fix.suggestion)) return { ok: false, error: `findings[${i}].harness_fix.suggestion not a string` };
    findings.push({
      type: x.type as FindingType,
      turn: x.turn,
      severity: x.severity as Severity,
      evidence: x.evidence,
      root_cause: x.root_cause,
      harness_fix: { target: fix.target as FixTarget, suggestion: fix.suggestion },
    });
  }
  return { ok: true, value: { findings, summary: obj.summary } };
}
