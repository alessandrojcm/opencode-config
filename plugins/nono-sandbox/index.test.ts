import { describe, expect, test } from "bun:test";
import plugin, { appendGuidance, buildGuidance, buildStatusReport, buildSystemContext, extractPath, type Caps } from "./index.ts";

const caps: Caps = {
  fs: [{ path: "~/repo", resolved: "/Users/me/repo", access: "readwrite" }],
  net_blocked: false,
  allowed_domains: ["api.example.com"],
  credentials: { github: { upstream: "https://api.github.com", credential_key: "GITHUB_TOKEN", inject_header: "Authorization" } },
  session_id: "sess-1",
};

describe("plugin definition", () => {
  test("is a V2 definition with an id and setup", () => {
    expect(plugin.id).toBe("nono-sandbox");
    expect(typeof plugin.setup).toBe("function");
  });
});

describe("extractPath", () => {
  test("finds an absolute path and strips trailing punctuation", () => {
    expect(extractPath("EACCES: open '/etc/hosts'.")).toBe("/etc/hosts");
  });
  test("expands ~/", () => {
    expect(extractPath("cannot read ~/.ssh/id_rsa")).toBe(`${Bun.env.HOME}/.ssh/id_rsa`);
  });
  test("returns null without a path", () => {
    expect(extractPath("permission denied")).toBeNull();
  });
});

describe("appendGuidance", () => {
  test("appends to string content", () => {
    expect(appendGuidance({ content: "denied" }, "\nG").content).toBe("denied\nG");
  });
  test("appends to the last text part", () => {
    const out = appendGuidance({ content: [{ type: "text", text: "a" }, { type: "file", uri: "x" }, { type: "text", text: "b" }] }, "!");
    expect(out.content).toEqual([{ type: "text", text: "a" }, { type: "file", uri: "x" }, { type: "text", text: "b!" }]);
  });
  test("adds a text part when none exists", () => {
    const out = appendGuidance({ content: [{ type: "file", uri: "x" }] }, "G");
    expect(out.content).toEqual([{ type: "file", uri: "x" }, { type: "text", text: "G" }]);
  });
  test("falls back to output, then to new content", () => {
    expect(appendGuidance({ output: "o" }, "G").output).toBe("oG");
    expect(appendGuidance({}, "\nG").content).toBe("G");
  });
  test("does not mutate the input", () => {
    const input = { content: "denied" };
    appendGuidance(input, "G");
    expect(input.content).toBe("denied");
  });
});

describe("text builders", () => {
  test("guidance names the blocked path and the two options", () => {
    const text = buildGuidance(caps, "/etc/hosts");
    expect(text).toContain("Blocked path: /etc/hosts");
    expect(text).toContain("nono why --self --path /etc/hosts --op read");
    expect(text).toContain("nono run --allow /etc/hosts -- opencode");
    expect(text).toContain("api.example.com");
  });
  test("system context mentions the session and allowlist", () => {
    const text = buildSystemContext(caps);
    expect(text).toContain("nono attach sess-1");
    expect(text).toContain("api.example.com");
  });
  test("status report handles no caps", () => {
    expect(buildStatusReport(null)).toContain("NONO_CAP_FILE is not set");
    expect(buildStatusReport(caps)).toContain("nono sandbox: active");
  });
});
