import { describe, expect, test } from "bun:test";
import { correlate, formatAge, formatTable, type HerdrWorkspace, type NonoSession } from "./lib.ts";

const session = (over: Partial<NonoSession>): NonoSession => ({
  session_id: "abc123",
  name: "calm-edge",
  status: "running",
  attachment: "attached",
  started: "2026-09-15T10:00:00+01:00",
  command: ["opencode", "--standalone", "/w/feature"],
  profile: "opencode-worktree",
  workdir: "/w/feature",
  ...over,
});

const ws = (id: string, checkout: string): HerdrWorkspace => ({ workspace_id: id, label: checkout.split("/").pop()!, worktree: { checkout_path: checkout } });

describe("correlate", () => {
  test("matches a sandbox to the workspace whose checkout is its workdir (ignoring trailing slash)", () => {
    const rows = correlate([session({ workdir: "/w/feature/" })], [ws("w5", "/w/feature")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orphan).toBe(false);
    expect(rows[0]!.workspace).toEqual({ id: "w5", label: "feature" });
  });

  test("flags a sandbox with no workspace as orphan and sorts orphans first", () => {
    const rows = correlate([session({ session_id: "ok1" }), session({ session_id: "lost", workdir: "/w/gone" })], [ws("w5", "/w/feature")]);
    expect(rows.map((r) => [r.session_id, r.orphan])).toEqual([
      ["lost", true],
      ["ok1", false],
    ]);
  });

  test("drops sessions that are not running and ignores workspaces without a worktree", () => {
    const rows = correlate([session({ status: "exited" })], [{ workspace_id: "w1", label: "x", worktree: null }]);
    expect(rows).toEqual([]);
  });
});

describe("formatting", () => {
  test("formatAge buckets", () => {
    const t0 = Date.parse("2026-09-15T10:00:00Z");
    expect(formatAge("2026-09-15T09:59:30Z", t0)).toBe("30s");
    expect(formatAge("2026-09-15T09:45:00Z", t0)).toBe("15m");
    expect(formatAge("2026-09-15T07:30:00Z", t0)).toBe("2h30m");
    expect(formatAge("2026-09-13T10:00:00Z", t0)).toBe("2d");
    expect(formatAge("garbage", t0)).toBe("?");
  });

  test("formatTable has a header and every row starts with the session id", () => {
    const rows = correlate([session({})], [ws("w5", "/w/feature")]);
    const lines = formatTable(rows);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("SESSION")).toBe(true);
    expect(lines[1]!.startsWith("abc123")).toBe(true);
    expect(lines[1]).toContain("attached");
  });
});
