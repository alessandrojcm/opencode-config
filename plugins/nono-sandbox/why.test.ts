import { describe, expect, test } from "bun:test";
import { buildDenyMessage, opForAction, parseWhy, resourceToPath, whyArgs } from "./why.ts";

const LOC = "/Users/me/worktrees/feature";
const HOME = "/Users/me";

describe("whyArgs", () => {
  test("path query", () => {
    expect(whyArgs({ kind: "path", path: "/etc", op: "write" })).toEqual(["why", "--self", "--json", "--path", "/etc", "--op", "write"]);
  });
  test("host query with and without port", () => {
    expect(whyArgs({ kind: "host", host: "api.github.com" })).toEqual(["why", "--self", "--json", "--host", "api.github.com"]);
    expect(whyArgs({ kind: "host", host: "x", port: 8080 })).toEqual(["why", "--self", "--json", "--host", "x", "--port", "8080"]);
  });
});

describe("parseWhy", () => {
  test("parses nono's JSON", () => {
    expect(parseWhy('{"status":"denied","reason":"filesystem_deny","details":"d","policy_source":"filesystem.deny"}')).toEqual({
      status: "denied",
      reason: "filesystem_deny",
      details: "d",
      policy_source: "filesystem.deny",
    });
  });
  test("returns null on garbage", () => {
    expect(parseWhy("nono: boom")).toBeNull();
    expect(parseWhy('{"no":"status"}')).toBeNull();
  });
});

describe("opForAction", () => {
  test("maps path actions and ignores others", () => {
    expect(opForAction("read")).toBe("read");
    expect(opForAction("external_directory")).toBe("read");
    expect(opForAction("edit")).toBe("write");
    expect(opForAction("shell")).toBeNull();
    expect(opForAction("glob")).toBeNull();
  });
});

describe("resourceToPath", () => {
  test("skips anything inside the worktree", () => {
    expect(resourceToPath("src/index.ts", LOC, HOME)).toBeNull();
    expect(resourceToPath(`${LOC}/src/index.ts`, LOC, HOME)).toBeNull();
    expect(resourceToPath(LOC, LOC, HOME)).toBeNull();
    expect(resourceToPath(`${LOC}/*`, LOC, HOME)).toBeNull();
  });
  test("does not treat a sibling with a shared prefix as inside", () => {
    expect(resourceToPath(`${LOC}-other/x`, LOC, HOME)).toBe(`${LOC}-other/x`);
  });
  test("returns absolute external paths, stripping trailing /*", () => {
    expect(resourceToPath("/Users/me/.ssh/*", LOC, HOME)).toBe("/Users/me/.ssh");
    expect(resourceToPath("/etc/hosts", LOC, HOME)).toBe("/etc/hosts");
  });
  test("expands ~", () => {
    expect(resourceToPath("~/.aws/credentials", LOC, HOME)).toBe("/Users/me/.aws/credentials");
    expect(resourceToPath("~", LOC, HOME)).toBe("/Users/me");
  });
  test("skips wildcards and empty resources", () => {
    expect(resourceToPath("*", LOC, HOME)).toBeNull();
    expect(resourceToPath("/Users/me/*.env", LOC, HOME)).toBeNull();
    expect(resourceToPath("", LOC, HOME)).toBeNull();
  });
});

describe("buildDenyMessage", () => {
  test("names path, op, reason and both options", () => {
    const msg = buildDenyMessage("/Users/me/.ssh", "read", { status: "denied", reason: "filesystem_deny", details: "covered by deny rule" }, "/Users/me/.config/nono/profile-drafts");
    expect(msg).toContain("read access to /Users/me/.ssh is denied");
    expect(msg).toContain("filesystem_deny: covered by deny rule");
    expect(msg).toContain("nono run --allow /Users/me/.ssh");
    expect(msg).toContain("/Users/me/.config/nono/profile-drafts/<name>.json");
  });
});
