import type { Plugin } from "@opencode-ai/plugin";

const GUIDANCE: Record<string, string> = {
  "ast-grep":
    "Use the astgrep_pattern tool for a single code shape, or astgrep_rule for relational/composite structural search. Do not shell out to ast-grep.",
  sg: "Use the astgrep_pattern tool for a single code shape, or astgrep_rule for relational/composite structural search. Do not shell out to ast-grep/sg.",
};

const BLOCKED_AST_GREP_COMMAND = /(?:^|[;&|]\s*)(ast-grep|sg)\b/;

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function blockedCommand(command: string) {
  const match = command.match(BLOCKED_AST_GREP_COMMAND);
  return match?.[1];
}

export default (async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;

      const command = output.args?.command;
      if (typeof command !== "string") return;

      const blocked = blockedCommand(command);
      if (!blocked) return;

      const guidance = GUIDANCE[blocked] ??
        "Use the dedicated code/search tools instead of shelling out.";
      const message = [
        `Blocked direct shell search command: ${blocked}`,
        guidance,
        `Original command was: ${command}`,
      ].join("\n");

      output.args.command = `printf %s\\n ${shellSingleQuote(message)} >&2; exit 2`;
    },
  };
}) satisfies Plugin;
