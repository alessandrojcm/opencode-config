import { describe, expect, test } from "bun:test";
import type { FrictionRow, RunRow, SessionRow } from "./db.ts";
import { defaultRetroExportPath, formatRetroReport, resolveMarkdownExportPath, writeMarkdownExport } from "./report.ts";

const run: RunRow = {
  id: "run_abc",
  session_id: "ses_private",
  ran_at: Date.parse("2026-09-10T12:00:00.000Z"),
  trigger: "manual",
  model: "provider/model",
  tokens: null,
  status: "ok",
  summary: "Needs a clearer workflow.",
  raw_output: null,
};

const session: SessionRow = {
  id: "ses_private",
  parent_id: null,
  project_dir: "/work/project",
  agent: "build",
  model: "provider/model",
  title: "Fix the workflow",
  first_seen: 1,
  last_seen: 2,
};

const rule: FrictionRow = {
  id: "fr_rule",
  session_id: session.id,
  turn_id: null,
  source: "rule",
  type: "blind_retry",
  severity: "medium",
  evidence: "The same command was repeated.",
  root_cause: null,
  fix_target: null,
  fix_suggestion: null,
  run_id: null,
  created: 1,
};

describe("retro Markdown report", () => {
  test("is actionable and retrieves database context by run ID without publishing the session ID", () => {
    const report = formatRetroReport({
      findings: 1,
      summary: run.summary!,
      run,
      session,
      rules: [rule],
      dbPath: "/data/session-retro.db",
      details: [
        {
          severity: "high",
          turn: 2,
          type: "instruction_violated",
          evidence: "Skipped validation.",
          harness_fix: { target: "agents_md", suggestion: "Require validation before completion." },
        },
      ],
    });

    expect(report).toContain("# Session retro: Fix the workflow");
    expect(report).toContain("## Actions");
    expect(report).toContain("- [ ] **agents_md:** Require validation before completion\\.");
    expect(report).toContain('"runID": "run_abc"');
    expect(report).toContain("where rr.id = 'run_abc';");
    expect(report).not.toContain("ses_private");
  });

  test("builds a stable default export path", () => {
    expect(defaultRetroExportPath(run.id, run.ran_at)).toBe("session-retros/2026-09-10-run_abc.md");
  });

  test("resolves project-relative, absolute, and home paths and adds the Markdown extension", () => {
    expect(resolveMarkdownExportPath("retros/run", "/work/project", "/home/me")).toBe("/work/project/retros/run.md");
    expect(resolveMarkdownExportPath("/exports/run.md", "/work/project", "/home/me")).toBe("/exports/run.md");
    expect(resolveMarkdownExportPath("~/run", "/work/project", "/home/me")).toBe("/home/me/run.md");
    expect(resolveMarkdownExportPath("~", "/work/project", "/home/me")).toBe("/home/me.md");
    expect(() => resolveMarkdownExportPath("../outside", "/work/project", "/home/me")).toThrow(/cannot contain/);
  });

  test("escapes report content that could alter Markdown or SQL structure", () => {
    const hostileRun = { ...run, id: "run_'quoted" };
    const report = formatRetroReport({
      findings: 1,
      summary: "# Injected\n[link](target)",
      run: hostileRun,
      session,
      rules: [{ ...rule, evidence: "*not emphasis*" }],
      dbPath: "/data/session-retro.db",
      details: [
        {
          severity: "high",
          turn: 1,
          type: "other",
          evidence: "# not a heading",
          harness_fix: { target: "agents_md", suggestion: "[not a link](target)" },
        },
      ],
    });
    expect(report).toContain("\\# Injected");
    expect(report).toContain("\\*not emphasis\\*");
    expect(report).toContain("where rr.id = 'run_''quoted';");
  });

  test("writes an export and creates the default path's missing parent directories", async () => {
    const root = `${import.meta.dir}/.tmp-export-${Date.now()}`;
    const path = resolveMarkdownExportPath(defaultRetroExportPath(run.id, run.ran_at), root);
    await writeMarkdownExport(path, "# Retro\n\nAction this.\n\n");
    expect(await Bun.file(path).text()).toBe("# Retro\n\nAction this.\n");
    await Bun.$`rm -rf ${root}`.quiet();
  });
});
