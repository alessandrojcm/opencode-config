import type { FixTarget, Severity, ToolCallRow, TurnRow } from "./db.ts";

export type RuleFinding = {
  type:
    | "flailing"
    | "blind_retry"
    | "tool_storm"
    | "blocked"
    | "interrupted"
    | "provider_retry"
    | "compaction"
    | "shell_for_search";
  severity: Severity;
  evidence: string;
  fixTarget?: FixTarget;
};

export type RuleContext = {
  /** p90 of tool calls per turn for this agent over history; undefined when no history. */
  agentP90: number | undefined;
  /** Effective tool names available to the agent (used by shell_for_search). */
  availableTools: ReadonlySet<string>;
};

const SHELL_TOOLS = new Set(["shell", "bash"]);
const SEARCH_CMD = /(?:^|[\s;&|(`])(rg|grep|ast-grep|sg|find)(?=\s|$)/;
const DEDICATED_SEARCH_TOOLS = ["grep", "glob"];

function isShell(call: ToolCallRow): boolean {
  return SHELL_TOOLS.has(call.tool);
}

function hasDedicatedSearch(tools: ReadonlySet<string>): boolean {
  if (DEDICATED_SEARCH_TOOLS.some((t) => tools.has(t))) return true;
  for (const t of tools) if (t.startsWith("astgrep_")) return true;
  return false;
}

export function detect(turn: TurnRow, calls: ToolCallRow[], ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];

  // flailing
  const groups = new Map<string, ToolCallRow[]>();
  for (const c of calls) {
    const key = `${c.tool}\u0000${c.input_hash}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  for (const g of groups.values()) {
    if (g.length >= 3) {
      const first = g[0]!;
      out.push({
        type: "flailing",
        severity: g.length >= 5 ? "high" : "medium",
        evidence: `${first.tool} called ${g.length}× with identical input: ${first.input_summary}`,
        fixTarget: "agents_md",
      });
    }
  }

  // blind_retry: a failed shell command whose *next shell* command is byte-identical
  for (let i = 0; i < calls.length - 1; i++) {
    const a = calls[i]!;
    if (!isShell(a) || a.status !== "error") continue;
    const b = calls.slice(i + 1).find(isShell);
    if (b && a.input_hash === b.input_hash) {
      out.push({
        type: "blind_retry",
        severity: "medium",
        evidence: `shell failed (${a.error ?? "error"}) then re-ran unchanged: ${a.input_summary}`,
        fixTarget: "agents_md",
      });
      break;
    }
  }

  // tool_storm
  const threshold = Math.max(20, ctx.agentP90 ?? 0);
  if (turn.tool_calls > threshold) {
    out.push({
      type: "tool_storm",
      severity: turn.tool_calls > threshold * 2 ? "high" : "medium",
      evidence: `${turn.tool_calls} tool calls in one turn (threshold ${threshold})`,
      fixTarget: "prompt",
    });
  }

  // blocked
  if (turn.permission_wait_ms > 60_000) {
    out.push({
      type: "blocked",
      severity: "medium",
      evidence: `waited ${Math.round(turn.permission_wait_ms / 1000)}s on permission prompts`,
      fixTarget: "permission",
    });
  }

  if (turn.outcome === "interrupted") {
    out.push({ type: "interrupted", severity: "medium", evidence: "turn was interrupted by the user", fixTarget: "none" });
  }

  if (turn.retries > 0) {
    out.push({
      type: "provider_retry",
      severity: "low",
      evidence: `${turn.retries} provider retr${turn.retries === 1 ? "y" : "ies"} (not a harness issue)`,
      fixTarget: "none",
    });
  }

  if (turn.compactions > 0) {
    out.push({
      type: "compaction",
      severity: "low",
      evidence: `${turn.compactions} context compaction${turn.compactions === 1 ? "" : "s"} during the turn`,
      fixTarget: "prompt",
    });
  }

  // shell_for_search
  if (hasDedicatedSearch(ctx.availableTools)) {
    const offenders = calls.filter((c) => isShell(c) && SEARCH_CMD.test(c.input_summary));
    if (offenders.length > 0) {
      out.push({
        type: "shell_for_search",
        severity: "low",
        evidence: `${offenders.length} shell search command${offenders.length === 1 ? "" : "s"} despite dedicated tools, e.g. ${offenders[0]!.input_summary}`,
        fixTarget: "agents_md",
      });
    }
  }

  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function hashInput(input: unknown): string {
  return new Bun.CryptoHasher("sha1")
    .update(JSON.stringify(canonical(input)) ?? "undefined")
    .digest("hex")
    .slice(0, 16);
}

const SUMMARY_KEYS = ["command", "path", "filePath", "file", "pattern", "query", "url", "sql", "prompt", "description"];
// Long enough that shell_for_search sees the whole command in almost every case.
const MAX_SUMMARY = 1000;

export function summarizeInput(_tool: string, input: unknown): string {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const key = SUMMARY_KEYS.find((k) => typeof obj[k] === "string");
    text = key ? (obj[key] as string) : JSON.stringify(obj);
  } else text = String(input);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}
