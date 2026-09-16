import { describe, expect, test } from "bun:test";
import { homeDueLabel, parseRetroCommand, promptDueLabel } from "./remind.ts";

describe("parseRetroCommand", () => {
  test("empty input runs the current session", () => {
    expect(parseRetroCommand()).toEqual({ kind: "run" });
    expect(parseRetroCommand("")).toEqual({ kind: "run" });
    expect(parseRetroCommand("   ")).toEqual({ kind: "run" });
  });

  test("accepts the documented verbs and ignores extra words", () => {
    expect(parseRetroCommand("pending")).toEqual({ kind: "pending" });
    expect(parseRetroCommand("settings extra")).toEqual({ kind: "settings" });
    expect(parseRetroCommand("SKIP")).toEqual({ kind: "skip" });
    expect(parseRetroCommand(" later ")).toEqual({ kind: "later" });
    expect(parseRetroCommand("always")).toEqual({ kind: "always" });
    expect(parseRetroCommand("never")).toEqual({ kind: "never" });
  });

  test("rejects unknown verbs instead of treating them as run", () => {
    expect(parseRetroCommand("foo")).toEqual({ kind: "unknown", arg: "foo" });
  });
});

describe("due reminder labels", () => {
  test("prompt footer names the slash command and stays silent when the session is not due", () => {
    expect(promptDueLabel("ses_1", ["ses_1"])).toBe("retro due · /retro");
    expect(promptDueLabel("ses_1", ["ses_2"])).toBeUndefined();
    expect(promptDueLabel(undefined, ["ses_1"])).toBeUndefined();
  });

  test("home footer reports the pending count and how to inspect it", () => {
    expect(homeDueLabel(0)).toBeUndefined();
    expect(homeDueLabel(1)).toBe("1 retro due · /retro pending");
    expect(homeDueLabel(3)).toBe("3 retros due · /retro pending");
  });
});
