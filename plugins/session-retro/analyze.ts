import { Result, Schema } from "effect";
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

const SEVERITIES = ["low", "medium", "high"] as const satisfies readonly Severity[];
const TARGETS = ["agents_md", "skill", "prompt", "permission", "plugin", "tool", "none"] as const satisfies readonly FixTarget[];

/**
 * Single source of truth for the LLM output shape. `parseAnalysis` decodes against it and
 * `outputShapeBlock()` renders it into the prompt, so enum values cannot drift between the two.
 * (ctx.generate.text has no structured-output mode in the current SDK; this is the parser-side equivalent.)
 */
export const LlmFinding = Schema.Struct({
  type: Schema.Literals(FINDING_TYPES),
  turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  severity: Schema.Literals(SEVERITIES),
  evidence: Schema.String,
  root_cause: Schema.String,
  harness_fix: Schema.Struct({ target: Schema.Literals(TARGETS), suggestion: Schema.String }),
});
export type LlmFinding = typeof LlmFinding.Type;

export const Analysis = Schema.Struct({ findings: Schema.Array(LlmFinding), summary: Schema.String });
export type Analysis = typeof Analysis.Type;

const decodeAnalysis = Schema.decodeUnknownResult(Analysis);

/** JSON skeleton shown to the model, derived from the same enum lists the schema uses. */
export function outputShapeBlock(): string {
  return `{"findings":[{"type":"${FINDING_TYPES.join("|")}",
  "turn":3,"severity":"${SEVERITIES.join("|")}","evidence":"…","root_cause":"…",
  "harness_fix":{"target":"${TARGETS.join("|")}","suggestion":"…"}}],
 "summary":"one or two sentences"}`;
}

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

/** Default template. Custom templates (options.analysisPromptPath) use the same two placeholders. */
export const DEFAULT_PROMPT_TEMPLATE = `You are reviewing a transcript of a coding-agent session to find friction that a better "harness"
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
{{hints}}

Transcript:
"""
{{transcript}}
"""`;

export const TRANSCRIPT_PLACEHOLDER = "{{transcript}}";
export const HINTS_PLACEHOLDER = "{{hints}}";

function renderHints(hints: RuleHint[]): string {
  return hints.length === 0 ? "(no deterministic findings)" : hints.map((h) => `- turn ${h.turn}: ${h.type} — ${h.evidence}`).join("\n");
}

/**
 * Build the analysis prompt. `template` defaults to DEFAULT_PROMPT_TEMPLATE; a custom template must
 * contain `{{transcript}}` (the hints placeholder is optional). The output-shape instructions are
 * always appended by this function so a custom prompt cannot desync from `parseAnalysis`.
 */
export function buildPrompt(transcript: string, hints: RuleHint[], template: string = DEFAULT_PROMPT_TEMPLATE): string {
  const tpl = template.includes(TRANSCRIPT_PLACEHOLDER) ? template : `${template}\n\nTranscript:\n"""\n${TRANSCRIPT_PLACEHOLDER}\n"""`;
  const body = tpl.split(TRANSCRIPT_PLACEHOLDER).join(transcript).split(HINTS_PLACEHOLDER).join(renderHints(hints));
  return `${body}

Respond with JSON only, no prose, matching exactly:
${outputShapeBlock()}

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

export function parseAnalysis(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const decoded = decodeAnalysis(data);
  if (Result.isFailure(decoded)) return { ok: false, error: String(decoded.failure).replace(/\s+/g, " ").trim() };
  return { ok: true, value: decoded.success };
}
