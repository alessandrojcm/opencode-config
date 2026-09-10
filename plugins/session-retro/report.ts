import type { FrictionRow, RunRow, SessionRow } from "./db.ts";

export type ReportFinding = {
  severity: string;
  turn: number;
  type: string;
  evidence: string;
  harness_fix: { target: string; suggestion: string };
};

export type RetroReportInput = {
  findings: number;
  summary: string;
  details?: ReadonlyArray<ReportFinding>;
  run: RunRow;
  session?: SessionRow;
  rules: ReadonlyArray<FrictionRow>;
  dbPath: string;
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#+.!|])/g, "\\$1").replace(/\r?\n/g, "  \n");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatRetroReport(input: RetroReportInput): string {
  const title = input.session?.title ? `: ${oneLine(input.session.title)}` : "";
  const lines = [
    `# Session retro${title}`,
    "",
    `- **Retro run:** ${code(input.run.id)}`,
    `- **Recorded:** ${new Date(input.run.ran_at).toISOString()}`,
    `- **Project:** ${code(input.session?.project_dir ?? "unknown")}`,
    `- **Database:** ${code(input.dbPath)}`,
    "",
    "## Summary",
    "",
    markdownText(input.summary),
  ];

  if (input.details?.length) {
    lines.push("", "## Findings", "");
    for (const finding of input.details) {
      lines.push(`- **${finding.severity.toUpperCase()} · turn ${finding.turn} · ${finding.type}** — ${markdownText(finding.evidence)}`);
      if (finding.harness_fix.target !== "none") {
        lines.push(`  - **Suggested fix (${code(finding.harness_fix.target)}):** ${markdownText(finding.harness_fix.suggestion)}`);
      }
    }

    const actions = input.details.filter((finding) => finding.harness_fix.target !== "none" && finding.harness_fix.suggestion.trim().length > 0);
    if (actions.length) {
      lines.push("", "## Actions", "");
      for (const finding of actions) {
        lines.push(`- [ ] **${finding.harness_fix.target}:** ${markdownText(finding.harness_fix.suggestion)}`);
      }
    }
  }

  if (input.rules.length) {
    lines.push("", "## Rule hits", "");
    for (const rule of input.rules) lines.push(`- **${rule.severity.toUpperCase()} · ${rule.type}** — ${markdownText(rule.evidence ?? "")}`);
  }

  lines.push(
    "",
    "## Retrieve recorded session data",
    "",
    "Use the `retro_context` tool with this retro run ID to retrieve the session record, turns, summarized tool calls, and findings from the retro database:",
    "",
    "```json",
    JSON.stringify({ runID: input.run.id }, null, 2),
    "```",
    "",
    "Or locate the session directly in SQLite:",
    "",
    "```sql",
    "select rr.*, s.*",
    "from retro_run rr",
    "join session s on s.id = rr.session_id",
    `where rr.id = ${sqlString(input.run.id)};`,
    "```",
    "",
  );

  return lines.join("\n");
}

export function defaultRetroExportPath(runID: string, ranAt: number): string {
  const date = new Date(ranAt).toISOString().slice(0, 10);
  return `session-retros/${date}-${runID}.md`;
}

export function resolveMarkdownExportPath(input: string, projectDir: string, home = Bun.env.HOME): string {
  let path = input.trim();
  if (path.length === 0) throw new Error("Enter a file path");
  if (path === "~" || path.startsWith("~/")) {
    if (!home) throw new Error("Cannot expand ~ because HOME is not set");
    path = path === "~" ? home : `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  }
  if (!path.toLowerCase().endsWith(".md")) path += ".md";
  if (path.startsWith("/")) return path;
  if (path.split("/").includes("..")) throw new Error("Project-relative paths cannot contain ..; use an absolute path instead");
  return `${projectDir.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

export async function writeMarkdownExport(path: string, report: string): Promise<void> {
  await Bun.write(path, `${report.replace(/\s+$/, "")}\n`);
}
