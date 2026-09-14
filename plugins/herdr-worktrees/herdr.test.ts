import { describe, expect, test } from "bun:test";
import {
  HerdrError,
  isForceRequired,
  isInside,
  parsePorcelain,
  parseResponse,
  samePath,
  splitLines,
  toCreateParams,
  toEntries,
  workspaceForCheckout,
  type WorkspaceInfo,
} from "./herdr.ts";

const ws = (id: string, checkout: string): WorkspaceInfo => ({
  workspace_id: id,
  label: id,
  worktree: { checkout_path: checkout, is_linked_worktree: false, repo_key: `${checkout}/.git`, repo_name: "repo", repo_root: checkout },
});

describe("socket framing", () => {
  test("splitLines keeps an unterminated tail", () => {
    expect(splitLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
  });

  test("parseResponse distinguishes result from error", () => {
    expect(parseResponse('{"id":"x","result":{"type":"ok"}}')).toEqual({ result: { type: "ok" } });
    expect(parseResponse('{"id":"x","error":{"code":"nope","message":"m"}}')).toEqual({ error: { code: "nope", message: "m" } });
  });
});

describe("paths", () => {
  test("samePath ignores trailing slashes", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/b", "/a/bc")).toBe(false);
  });

  test("isInside only matches real descendants", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
  });

  test("workspaceForCheckout finds by checkout path", () => {
    const list = [ws("w1", "/repo"), ws("w2", "/trees/x")];
    expect(workspaceForCheckout(list, "/trees/x/")?.workspace_id).toBe("w2");
    expect(workspaceForCheckout(list, "/elsewhere")).toBeUndefined();
  });
});

describe("toCreateParams", () => {
  test("uses the source workspace and names the branch after the worktree", () => {
    const params = toCreateParams({ sourceDirectory: "/repo", directory: "/trees/task-a" }, ws("w1", "/repo"));
    expect(params).toEqual({ workspace_id: "w1", path: "/trees/task-a", branch: "task-a", label: "task-a", focus: false });
  });

  test("falls back to cwd when herdr has no workspace for the source, and maps branch to base", () => {
    const params = toCreateParams({ sourceDirectory: "/repo", directory: "/trees/task-a", branch: "main" }, undefined);
    expect(params.cwd).toBe("/repo");
    expect(params.workspace_id).toBeUndefined();
    expect(params.base).toBe("main");
  });
});

describe("listing", () => {
  test("toEntries maps linked worktrees", () => {
    const entries = toEntries({
      type: "worktree_list",
      source: { repo_root: "/repo", source_checkout_path: "/repo" },
      worktrees: [
        { path: "/repo", is_linked_worktree: false, is_bare: false, is_detached: false, is_prunable: false, label: "repo" },
        { path: "/trees/a", is_linked_worktree: true, is_bare: false, is_detached: false, is_prunable: false, label: "repo" },
      ],
    });
    expect(entries).toEqual([
      { directory: "/repo", type: "root" },
      { directory: "/trees/a", type: "worktree" },
    ]);
  });

  test("parsePorcelain reads git worktree list --porcelain", () => {
    const text = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /trees/a\nHEAD def\ndetached\n\n";
    expect(parsePorcelain(text)).toEqual([
      { directory: "/repo", type: "root" },
      { directory: "/trees/a", type: "worktree" },
    ]);
  });
});

describe("errors", () => {
  test("isForceRequired recognises herdr's dirty-worktree code", () => {
    expect(isForceRequired(new HerdrError({ code: "dirty_worktree_requires_force", message: "x" }))).toBe(true);
    expect(isForceRequired(new HerdrError({ code: "other", message: "x" }))).toBe(false);
    expect(isForceRequired(new Error("x"))).toBe(false);
  });
});
