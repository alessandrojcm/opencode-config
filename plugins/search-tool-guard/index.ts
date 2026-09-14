import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";

const GUIDANCE = {
  "ast-grep":
    "Use the astgrep_pattern tool for a single code shape, or astgrep_rule for relational/composite structural search. Do not shell out to ast-grep.",
  sg: "Use the astgrep_pattern tool for a single code shape, or astgrep_rule for relational/composite structural search. Do not shell out to ast-grep/sg.",
} satisfies Record<string, string>;

const BLOCKED_AST_GREP_COMMAND = /(?:^|[;&|]\s*)(ast-grep|sg)\b/;
type BlockedCommand = keyof typeof GUIDANCE;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function blockedCommand(command: string): BlockedCommand | undefined {
  const candidate = command.match(BLOCKED_AST_GREP_COMMAND)?.[1];
  return candidate === "ast-grep" || candidate === "sg" ? candidate : undefined;
}

export default Plugin.define({
  id: "search-tool-guard",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.shell.hook("create.before", (event) =>
        Effect.sync(() => {
          const blocked = blockedCommand(event.command);
          if (!blocked) return;

          const guidance = GUIDANCE[blocked];
          const message = [
            `Blocked direct shell search command: ${blocked}`,
            guidance,
            `Original command was: ${event.command}`,
          ].join("\n");
          event.command = `printf '%s\\n' ${shellSingleQuote(message)} >&2; exit 2`;
        }),
      );
    }),
});
