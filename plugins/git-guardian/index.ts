import { Plugin } from "@opencode/plugin";
import { buildGitButlerInstructions, isDirectGitCommand } from "./policy";

/**
 * Git Guardian
 *
 * Globally directs agents to use GitButler and blocks direct `git` commands
 * through the shell tool. Existing Git repositories need no separate
 * GitButler initialization; unversioned projects are initialized with `but
 * init` only when the task requires version control.
 */
export default Plugin.define({
  id: "git-guardian",
  async setup(ctx) {
    console.info("Git Guardian plugin initialized");

    await ctx.session.hook("context", async (event) => {
      try {
        const isGitRepository = await detectGitRepository(
          ctx.location.directory,
        );
        event.system.push({
          type: "text",
          text: buildGitButlerInstructions(isGitRepository),
        });
      } catch (error) {
        console.warn("Git Guardian could not add GitButler instructions", error);
      }
    });

    await ctx.permission.hook("evaluate", (event) => {
      try {
        if (event.action !== "shell") return;

        const blocked = event.resources.some(
          (resource) =>
            typeof resource === "string" && isDirectGitCommand(resource),
        );

        if (blocked) {
          event.effect = "deny";
          event.message =
            "Direct `git` commands are not allowed. Use GitButler (`but`) instead.\n" +
            "If this directory is not yet a Git repository and version control is needed, initialize it with `but init`.\n" +
            "For GitButler workflows, start with `but status` or `but diff`; see the `but` skill for command guidance.";
        }
      } catch (error) {
        console.warn("Git Guardian could not evaluate a shell permission", error);
      }
    });
  },
});

async function detectGitRepository(directory: string): Promise<boolean> {
  try {
    const runtime = (globalThis as { Bun?: unknown }).Bun as
      | {
          spawnSync: (
            cmd: string[],
            opts: Record<string, unknown>,
          ) => { exitCode: number };
        }
      | undefined;
    if (!runtime) return false;

    const result = runtime.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: directory,
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    // A failed probe is treated as a directory without a Git repository.
    return false;
  }
}
