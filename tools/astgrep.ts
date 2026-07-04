import { tool } from "@opencode-ai/plugin";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Language aliases ast-grep's built-in tree-sitter grammars support.
// Source: https://ast-grep.github.io/reference/languages.html
// Multiple aliases map to the same grammar; we expose the idiomatic one per
// language plus common alternates so the model can use whichever it remembers.
const LANGS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "hcl",
  "html",
  "java",
  "javascript",
  "js",
  "jsx",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const;

type Lang = typeof LANGS[number];

const EXT_BY_LANG: Record<Lang, string> = {
  bash: ".sh",
  c: ".c",
  cpp: ".cpp",
  csharp: ".cs",
  css: ".css",
  elixir: ".ex",
  go: ".go",
  haskell: ".hs",
  hcl: ".hcl",
  html: ".html",
  java: ".java",
  javascript: ".js",
  js: ".js",
  jsx: ".jsx",
  json: ".json",
  kotlin: ".kt",
  lua: ".lua",
  nix: ".nix",
  php: ".php",
  python: ".py",
  ruby: ".rb",
  rust: ".rs",
  scala: ".scala",
  solidity: ".sol",
  swift: ".swift",
  typescript: ".ts",
  tsx: ".tsx",
  yaml: ".yaml",
};

const langSchema = z.enum(LANGS);
const debugFormatSchema = z.enum(["pattern", "ast", "cst", "sexp"]);

const astGrepExe = "ast-grep";

async function runAstGrep(
  args: string[],
  cwd: string,
  abort: AbortSignal | undefined,
): Promise<string> {
  // Bun.$ exposes no .abort() builder method in current releases, so use
  // Bun.spawn directly to get real AbortSignal support and explicit stdout/stderr.
  const proc = Bun.spawn({
    cmd: [astGrepExe, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: abort,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const out = stdout.trim();
  const err = stderr.trim();
  // ast-grep exits 0 even on pattern parse errors, putting warnings on stderr.
  // If there were no matches AND there's a stderr warning, surface it so the
  // model can self-correct instead of getting a silent empty result.
  if (out === "[]" && err) {
    return `[]\n\nast-grep warning:\n${err}`;
  }
  if (exitCode !== 0 && !out) {
    return `ast-grep exited ${exitCode}${err ? `\n${err}` : ""}`;
  }
  return out || err || "(no output)";
}

function fullRuleFor(lang: Lang, ruleBody: string): string {
  return `id: opencode-indexer
language: ${lang}
rule:
  ${ruleBody.replace(/\n/g, "\n  ")}`;
}

async function runAstGrepOnSnippet(
  argsBeforePath: string[],
  lang: Lang,
  code: string,
  cwd: string,
  abort: AbortSignal | undefined,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-astgrep-"));
  const tempFile = join(tempDir, `snippet${EXT_BY_LANG[lang]}`);
  await writeFile(tempFile, code);
  try {
    return await runAstGrep([...argsBeforePath, tempFile], cwd, abort);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---- astgrep_pattern: simple single-node search via `run --pattern` ----
export const pattern = tool({
  description: `Structural code search using ast-grep's simple pattern mode.

Use this for matching a single AST node by structural shape. Pass the code
shape as \`pattern\`, using ast-grep metavariables:
  $NAME    — match a single node (identifier, literal, etc.) and capture it
  $$$ARGS — match zero or more nodes (e.g. function arguments, body statements)

IMPORTANT: a pattern must structurally match the WHOLE node, including braces.
"function $NAME($$$)" matches NOTHING because it has no body — use one of:
  function $NAME                         — any function declaration (no body capture)
  function $NAME($$$) { $$$ }            — any function declaration with body

Examples of patterns that work:
  function $NAME                          — any function declaration
  function $NAME($$$) { $$$ }             — any function declaration with body
  app.get($ROUTE, $$$)                    — express GET routes
  console.log($$$)                        — any console.log call
  class $NAME                              — any class declaration
  $OBJ.$METHOD($$$)                        — any method call on an object

Always pass \`--json\` automatically (this tool does it for you) so you get
file, line range, and matched text back.

When to use this tool:
- You need to find occurrences of a code SHAPE, not text.
- Single-node matches (no need to express "X that contains Y").

For relational queries ("function that contains an await", "route handler that
calls adminMiddleware"), use the \`astgrep_rule\` tool instead, which supports
YAML rules with inside/has/not.

If a pattern misses unexpectedly, do not shell out. Use \`astgrep_test_pattern\`
on a tiny representative snippet and \`astgrep_debug_pattern\` to inspect how
ast-grep parses the query.`,
  args: {
    pattern: z
      .string()
      .describe(
        "ast-grep pattern, e.g. 'app.get($ROUTE, $$$)' or 'class $NAME'. $VAR captures one node, $$$ captures zero+ nodes.",
      ),
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory to search. Defaults to the session's project directory (worktree).",
      ),
  },
  async execute(args, context) {
    const target =
      args.path && args.path.length > 0 ? args.path : context.worktree;
    const out = await runAstGrep(
      [
        "run",
        "--pattern",
        args.pattern,
        "--lang",
        args.lang,
        "--json=compact",
        target,
      ],
      context.directory,
      context.abort,
    );
    return {
      title: `ast-grep pattern · ${args.lang}`,
      output: out,
      metadata: { pattern: args.pattern, lang: args.lang, path: target },
    };
  },
});

// ---- astgrep_replace: structural search and replace via `run --rewrite` ----
export const replace = tool({
  description: `Structural search and replace using ast-grep's simple pattern rewrite mode.

Use this when you want to rewrite code by AST shape, not by plain text. It runs

  ast-grep run --pattern <pattern> --rewrite <replacement> --lang <lang>

By default this tool is a preview/dry run: it reports the matches ast-grep would
rewrite but does not modify files. Set \`apply: true\` to pass \`--update-all\`
and apply every rewrite non-interactively. This tool intentionally never uses
\`--interactive\`, because API tool calls cannot answer prompts.

Metavariables from the pattern are available in the replacement:
  pattern:  $OBJ.$METHOD($$$ARGS)
  rewrite:  $METHOD.call($OBJ, $$$ARGS)

Examples:
  pattern:  console.log($$$ARGS)
  rewrite:  logger.debug($$$ARGS)

  pattern:  $A && $A()
  rewrite:  $A?.()

When to use this tool:
- You need a mechanical AST-aware replacement across a file or directory.
- A simple single-node pattern can express the match.

When NOT to use it:
- Complex relational conditions are required; first use \`astgrep_rule\` to find
  candidates, then apply narrower replacements deliberately.
- You have not previewed or otherwise verified the rewrite. Prefer the default
  preview first, then rerun with \`apply: true\` after reviewing matches.

Notes:
- The replacement is ast-grep rewrite syntax, not a JavaScript template string.
- \`apply: true\` updates files in place with ast-grep's \`--update-all\` flag.
- Defaults to the session's worktree when \`path\` is omitted.`,
  args: {
    pattern: z
      .string()
      .describe(
        "ast-grep pattern to search for, e.g. 'console.log($$$ARGS)' or '$A && $A()'.",
      ),
    rewrite: z
      .string()
      .describe(
        "Replacement using ast-grep metavariables from the pattern, e.g. 'logger.debug($$$ARGS)' or '$A?.()'.",
      ),
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory to rewrite. Defaults to the session's project directory (worktree).",
      ),
    apply: z
      .boolean()
      .optional()
      .describe(
        "When true, pass --update-all and modify files in place. Defaults to false for preview/dry-run.",
      ),
  },
  async execute(args, context) {
    const target =
      args.path && args.path.length > 0 ? args.path : context.worktree;
    const cliArgs = [
      "run",
      "--pattern",
      args.pattern,
      "--rewrite",
      args.rewrite,
      "--lang",
      args.lang,
      "--json=compact",
    ];
    if (args.apply === true) {
      cliArgs.push("--update-all");
    }
    cliArgs.push(target);
    const out = await runAstGrep(cliArgs, context.directory, context.abort);
    const mode = args.apply === true ? "apply" : "preview";
    return {
      title: `ast-grep replace · ${args.lang} · ${mode}`,
      output: out,
      metadata: {
        pattern: args.pattern,
        rewrite: args.rewrite,
        lang: args.lang,
        path: target,
        apply: args.apply === true,
      },
    };
  },
});

// ---- astgrep_debug_pattern: inspect how ast-grep parses a query pattern ----
export const debug_pattern = tool({
  description: `Debug how ast-grep parses a query pattern.

Use this when a structural search misses unexpectedly, when you need a tree-sitter
kind name for a representative code shape, or when an incomplete/ambiguous snippet
needs a pattern-object context/selector. This runs ast-grep's \`--debug-query\`
mode; it does not search the codebase and it does not require shell quoting.

Prefer \`format: "cst"\` when discovering exact node kinds, \`format: "ast"\` for
named AST nodes, and \`format: "pattern"\` to inspect metavariable parsing.`,
  args: {
    pattern: z
      .string()
      .describe(
        "Representative ast-grep pattern/snippet to parse, e.g. 'class A { $FIELD = $INIT }'.",
      ),
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    format: debugFormatSchema
      .optional()
      .describe(
        "Debug output format. Defaults to 'cst'. Use 'cst' for exact kind names, 'ast' for named nodes, 'pattern' for metavariables, or 'sexp'.",
      ),
    selector: z
      .string()
      .optional()
      .describe(
        "Optional node kind to select from the parsed pattern, useful before turning a context snippet into a rule pattern object.",
      ),
  },
  async execute(args, context) {
    const format = args.format ?? "cst";
    const cliArgs = [
      "run",
      "--pattern",
      args.pattern,
      "--lang",
      args.lang,
      `--debug-query=${format}`,
    ];
    if (args.selector) {
      cliArgs.push("--selector", args.selector);
    }
    const out = await runAstGrep(cliArgs, context.directory, context.abort);
    return {
      title: `ast-grep debug pattern · ${args.lang} · ${format}`,
      output: out,
      metadata: {
        pattern: args.pattern,
        lang: args.lang,
        format,
        selector: args.selector,
      },
    };
  },
});

// ---- astgrep_test_pattern: trial a simple pattern against example code ----
export const test_pattern = tool({
  description: `Test a simple ast-grep pattern against a tiny representative code snippet.

Use this before searching the whole codebase when you are developing or debugging
a non-trivial pattern. It writes the snippet to a temporary file, runs ast-grep
with \`--json=compact\`, and returns the match JSON. It is not a codebase search;
use \`astgrep_pattern\` after the pattern matches the snippet.`,
  args: {
    pattern: z
      .string()
      .describe(
        "ast-grep pattern to test, e.g. 'console.log($$$)' or 'function $NAME($$$) { $$$ }'.",
      ),
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    code: z
      .string()
      .describe(
        "Small positive example code snippet that should match the pattern.",
      ),
  },
  async execute(args, context) {
    const out = await runAstGrepOnSnippet(
      ["run", "--pattern", args.pattern, "--lang", args.lang, "--json=compact"],
      args.lang,
      args.code,
      context.directory,
      context.abort,
    );
    return {
      title: `ast-grep test pattern · ${args.lang}`,
      output: out,
      metadata: { pattern: args.pattern, lang: args.lang },
    };
  },
});

// ---- astgrep_rule: relational/composite search via `scan --inline-rules` ----
const ruleSchema = z.string()
  .describe(`YAML rule body (everything under \`rule:\`). This tool wraps it in
{id, language, rule: <your yaml>} and runs \`ast-grep scan --inline-rules\`.

Translate the parent agent's natural-language request:
  "X that calls/contains Y"  ->  pattern: X
                                   has:    { pattern: Y, stopBy: end }
  "X inside Y"                ->  pattern: X
                                   inside: { kind: <Y node kind>, stopBy: end }
  "X without Y"               ->  pattern: X
                                   not:    { has: { pattern: Y, stopBy: end } }

ALWAYS add \`stopBy: end\` on every relational rule (inside/has/precedes/follows).
Without it ast-grep stops at the first non-matching child and silently misses matches.

Use \`kind:\` to match a node type instead of a literal shape. Find kind names by
calling \`astgrep_debug_pattern\` with \`format: "cst"\` on a representative snippet —
do not shell out. Prefer pattern-based rules when possible.

If a direct pattern is incomplete or ambiguous, use a pattern object with context
and selector, for example:
  pattern:
    context: class A { $FIELD = $INIT }
    selector: field_definition

Composite operators: \`all:\`, \`any:\`, \`not:\` accept lists of sub-rules.

Example rule body (note: NO leading "rule:" — start at the rule's children):
  pattern: app.get($$$)
  has:
    pattern: adminMiddleware
    stopBy: end

Another example (async functions with no try/catch):
  all:
    - kind: function_declaration
    - has:
        pattern: await $EXPR
        stopBy: end
    - not:
        has:
          pattern: try { $$$ } catch ($E) { $$$ }
          stopBy: end

Keep rules as simple as possible. If you get no matches, simplify: drop a sub-clause,
test the simplified rule with \`astgrep_test_rule\`, or switch the outer \`pattern:\`
to a \`kind:\` you've confirmed with \`astgrep_debug_pattern\`.`);

// ---- astgrep_test_rule: trial a YAML rule against example code ----
export const test_rule = tool({
  description: `Test a relational/composite ast-grep YAML rule against a tiny representative code snippet.

Use this while developing complex rules: first break the query into sub-rules,
combine them, then verify the rule against a positive example before searching
the real codebase. If it returns no matches, simplify the rule or inspect the
query with \`astgrep_debug_pattern\`. It is not a codebase search; use
\`astgrep_rule\` after the rule matches the snippet.`,
  args: {
    rule: ruleSchema,
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    code: z
      .string()
      .describe(
        "Small positive example code snippet that should match the YAML rule body.",
      ),
  },
  async execute(args, context) {
    const fullRule = fullRuleFor(args.lang, args.rule);
    const out = await runAstGrepOnSnippet(
      ["scan", "--inline-rules", fullRule, "--json=compact"],
      args.lang,
      args.code,
      context.directory,
      context.abort,
    );
    return {
      title: `ast-grep test rule · ${args.lang}`,
      output: out,
      metadata: { rule: fullRule, lang: args.lang },
    };
  },
});

export const rule = tool({
  description: `Structural code search using ast-grep's YAML rule mode (relational/composite).

Use this when the query needs "inside", "has", "not", "all", "any", or multiple
conditions on the same node — anything a single pattern can't express.

You supply only the rule BODY (the contents of \`rule:\`); this tool wraps it and
runs \`ast-grep scan --inline-rules\` with \`--json=compact\` output. You never have
to shell-escape \`$\` metavariables — pass them through verbatim in the YAML string.

Always add \`stopBy: end\` on relational sub-rules. See the \`rule\` arg description
for the translation recipes and worked examples. For complex rules, first validate
against a tiny positive snippet with \`astgrep_test_rule\`; if parsing or kinds are
unclear, inspect a representative query with \`astgrep_debug_pattern\`.`,
  args: {
    rule: ruleSchema,
    lang: langSchema.describe(
      "Tree-sitter language to parse as. Always pass this.",
    ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory to search. Defaults to the session's project directory (worktree).",
      ),
  },
  async execute(args, context) {
    const target =
      args.path && args.path.length > 0 ? args.path : context.worktree;
    const fullRule = fullRuleFor(args.lang, args.rule);
    const out = await runAstGrep(
      ["scan", "--inline-rules", fullRule, "--json=compact", target],
      context.directory,
      context.abort,
    );
    return {
      title: `ast-grep rule · ${args.lang}`,
      output: out,
      metadata: { rule: fullRule, lang: args.lang, path: target },
    };
  },
});

export default pattern;
