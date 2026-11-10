import { describe, expect, it } from "bun:test";
import {
  buildGitButlerInstructions,
  isDirectGitCommand,
} from "./policy";

describe("isDirectGitCommand", () => {
  it("matches direct git commands and commands after shell separators", () => {
    expect(isDirectGitCommand("git status")).toBe(true);
    expect(isDirectGitCommand("cd app && git log")).toBe(true);
    expect(isDirectGitCommand("echo ready; git diff")).toBe(true);
    expect(isDirectGitCommand("echo ready | git status")).toBe(true);
    expect(isDirectGitCommand("echo ready\ngit status")).toBe(true);
    expect(isDirectGitCommand("command git status")).toBe(true);
  });

  it("does not match commands that merely mention Git", () => {
    expect(isDirectGitCommand("but status")).toBe(false);
    expect(isDirectGitCommand("echo git status")).toBe(false);
  });
});

describe("buildGitButlerInstructions", () => {
  it("explains that existing Git repositories need no separate setup", () => {
    const instructions = buildGitButlerInstructions(true);

    expect(instructions).toContain("needs no separate initialization step");
    expect(instructions).toContain("but config target <branch>");
    expect(instructions).toContain("linked worktrees too");
    expect(instructions).not.toContain("use `but init` rather than `git init`");
  });

  it("directs unversioned projects to use but init only when needed", () => {
    const instructions = buildGitButlerInstructions(false);

    expect(instructions).toContain("not currently a Git repository");
    expect(instructions).toContain("For a task that changes or tracks project files");
    expect(instructions).toContain("Do not create a repository for read-only questions");
    expect(instructions).toContain("with `but init` rather than `git init`");
  });
});
