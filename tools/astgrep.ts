import { Plugin } from "@opencode-ai/plugin/effect";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Language aliases ast-grep's built-in tree-sitter grammars support.
// Source: https://ast-grep.github.io/reference/languages.html
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

const astGrepExe = "ast-grep";

export const EMPTY_PATTERN_RESULT_HINT =
  "Hint: No structural matches. If this miss was unexpected, do not switch to grep. " +
  "Call astgrep_test_pattern with a tiny positive snippet; if that misses, call " +
  "astgrep_debug_pattern with format cst, then retry once with a broader whole-node pattern.";

export const EMPTY_RULE_RESULT_HINT =
  "Hint: No structural matches. If this miss was unexpected, do not switch to grep. " +
  "Call astgrep_test_rule with a tiny positive snippet; if that misses or the target kind " +
  "is uncertain, call astgrep_debug_pattern with format cst, simplify the rule, and retry once.";

export const EMPTY_PATTERN_TEST_RESULT_HINT =
  "Hint: The pattern did not match its positive snippet. Call astgrep_debug_pattern with " +
  "format cst, correct the whole-node pattern, and retest it before searching the repository.";

export const EMPTY_RULE_TEST_RESULT_HINT =
  "Hint: The rule did not match its positive snippet. Debug the target construct with " +
  "astgrep_debug_pattern using format cst, simplify the rule, and retest it before searching the repository.";

export function withEmptyResultHint(output: string, hint: string): string {
  return output === "[]" ? `${output}\n\n${hint}` : output;
}

async function runAstGrep(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const proc = Bun.spawn({
    cmd: [astGrepExe, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const out = stdout.trim();
  const err = stderr.trim();

  // ast-grep exits 0 for pattern parse errors and puts warnings on stderr.
  if (out === "[]" && err) return `[]\n\nast-grep warning:\n${err}`;
  if (exitCode !== 0 && !out) {
    return `ast-grep exited ${exitCode}${err ? `\n${err}` : ""}`;
  }
  return out || err || "(no output)";
}

const runAstGrepEffect = Effect.fn("astgrep.runAstGrep")(function* (
  args: string[],
  cwd: string,
) {
  return yield* Effect.tryPromise({
    try: (signal) => runAstGrep(args, cwd, signal),
    catch: (cause) =>
      `ast-grep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  }).pipe(Effect.catch((message) => Effect.succeed(message)));
});

function fullRuleFor(lang: Lang, ruleBody: string): string {
  return `id: opencode-indexer
language: ${lang}
rule:
  ${ruleBody.replace(/\n/g, "\n  ")}`;
}

const runAstGrepOnSnippet = Effect.fn("astgrep.runAstGrepOnSnippet")(function* (
  argsBeforePath: string[],
  lang: Lang,
  code: string,
  cwd: string,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const tempDir = await mkdtemp(join(tmpdir(), "opencode-astgrep-"));
      const tempFile = join(tempDir, `snippet${EXT_BY_LANG[lang]}`);
      await writeFile(tempFile, code);
      try {
        return await runAstGrep([...argsBeforePath, tempFile], cwd, signal);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      `ast-grep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  }).pipe(Effect.catch((message) => Effect.succeed(message)));
});

const LangSchema = Schema.Literals(LANGS).annotate({
  description: "Tree-sitter language to parse as. Always pass this.",
});

const PathSchema = Schema.optional(Schema.String).annotate({
  description: "File or directory to search. Defaults to the current session directory.",
});

const PatternInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description:
      "ast-grep pattern, e.g. 'app.get($ROUTE, $$$)' or 'class $NAME'. $VAR captures one node and $$$ captures zero or more nodes.",
  }),
  lang: LangSchema,
  path: PathSchema,
});

const ReplaceInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "ast-grep pattern to search for, e.g. 'console.log($$$ARGS)'.",
  }),
  rewrite: Schema.String.annotate({
    description: "Replacement using metavariables captured by the pattern, e.g. 'logger.debug($$$ARGS)'.",
  }),
  lang: LangSchema,
  path: PathSchema,
  apply: Schema.optional(Schema.Boolean).annotate({
    description: "When true, pass --update-all and modify files in place. Defaults to false for preview/dry-run.",
  }),
});

const DebugPatternInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Representative ast-grep pattern/snippet to parse, e.g. 'class A { $FIELD = $INIT }'.",
  }),
  lang: LangSchema,
  format: Schema.optional(Schema.Literals(["pattern", "ast", "cst", "sexp"])).annotate({
    description: "Debug output format. Defaults to cst; use cst for exact node kinds and ast for named nodes.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "Optional node kind to select from the parsed pattern.",
  }),
});

const TestPatternInput = Schema.Struct({
  pattern: Schema.String.annotate({ description: "ast-grep pattern to test." }),
  lang: LangSchema,
  code: Schema.String.annotate({
    description: "Small positive example code snippet that should match the pattern.",
  }),
});

const RuleSchema = Schema.String.annotate({
  description: `YAML rule body (everything under rule:). This tool wraps it in {id, language, rule: <your yaml>}.

Translate relational requests with has, inside, not, all, or any. ALWAYS add stopBy: end on every relational rule (inside/has/precedes/follows); otherwise ast-grep may stop at the first non-matching child.

Use astgrep_debug_pattern with format cst to find node kind names. If a direct pattern is incomplete or ambiguous, use a pattern object with context and selector. Do not include a leading rule: key.`,
});

const RuleInput = Schema.Struct({
  rule: RuleSchema,
  lang: LangSchema,
  path: PathSchema,
});

const TestRuleInput = Schema.Struct({
  rule: RuleSchema,
  lang: LangSchema,
  code: Schema.String.annotate({
    description: "Small positive example code snippet that should match the YAML rule body.",
  }),
});

const patternDescription = `Structural code search using ast-grep's simple pattern mode.

Use this for one AST node by structural shape. Metavariables: $NAME matches one node; $$$ARGS matches zero or more nodes. Patterns match a WHOLE node, including braces: use function $NAME or function $NAME($$$) { $$$ }, not an incomplete declaration.

The result is compact JSON with file, line range, and matched text. For relational queries such as "function that contains await" or "route handler that calls adminMiddleware", use astgrep_rule. If this misses unexpectedly, use astgrep_test_pattern and astgrep_debug_pattern; do not shell out.`;

const replaceDescription = `Structural AST-aware search and replace using ast-grep's pattern/rewrite mode.

The default is a preview. Set apply: true only after reviewing the preview; it passes --update-all and edits files in place. Use simple single-node patterns only. For relational conditions, locate candidates with astgrep_rule and apply narrower edits deliberately.`;

const debugDescription = `Debug how ast-grep parses a query pattern without searching the codebase. Use cst to discover exact tree-sitter kinds, ast for named nodes, and pattern to inspect metavariables. This is the recovery tool when an expected structural pattern misses.`;

const testPatternDescription = `Test a simple ast-grep pattern against a representative code snippet before searching the repository. It writes the snippet to a temporary file and returns compact match JSON. Use astgrep_pattern after the pattern matches.`;

const ruleDescription = `Structural code search using ast-grep YAML rule mode for relational or composite queries. Use inside, has, not, all, or any when a single pattern cannot express the query. Supply only the contents under rule:. Always add stopBy: end to relational sub-rules. Validate complex rules first with astgrep_test_rule.`;

const testRuleDescription = `Test a relational or composite ast-grep YAML rule against a representative code snippet before searching the repository. If it does not match, simplify it or inspect a representative construct with astgrep_debug_pattern using cst.`;

export default Plugin.define({
  id: "astgrep",
  effect: (ctx) =>
    Effect.gen(function* () {
      const sessionDirectory = ctx.location.directory;

      yield* ctx.tool.transform((draft) => {
        draft.add({
          name: "astgrep_pattern",
          description: patternDescription,
          input: PatternInput,
          options: { codemode: true },
          execute: ({ pattern, lang, path }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const target = path && path.length > 0 ? path : cwd;
              const output = yield* runAstGrepEffect(
                ["run", "--pattern", pattern, "--lang", lang, "--json=compact", target],
                cwd,
              );
              return {
                content: withEmptyResultHint(output, EMPTY_PATTERN_RESULT_HINT),
                metadata: { title: `ast-grep pattern · ${lang}`, pattern, lang, path: target },
              };
            }),
        });

        draft.add({
          name: "astgrep_replace",
          description: replaceDescription,
          input: ReplaceInput,
          options: { codemode: true },
          execute: ({ pattern, rewrite, lang, path, apply }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const target = path && path.length > 0 ? path : cwd;
              const args = [
                "run",
                "--pattern",
                pattern,
                "--rewrite",
                rewrite,
                "--lang",
                lang,
                "--json=compact",
              ];
              if (apply === true) args.push("--update-all");
              args.push(target);
              const output = yield* runAstGrepEffect(args, cwd);
              const mode = apply === true ? "apply" : "preview";
              return {
                content: output,
                metadata: { title: `ast-grep replace · ${lang} · ${mode}`, pattern, rewrite, lang, path: target, apply: apply === true },
              };
            }),
        });

        draft.add({
          name: "astgrep_debug_pattern",
          description: debugDescription,
          input: DebugPatternInput,
          options: { codemode: true },
          execute: ({ pattern, lang, format, selector }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const resolvedFormat = format ?? "cst";
              const args = ["run", "--pattern", pattern, "--lang", lang, `--debug-query=${resolvedFormat}`];
              if (selector) args.push("--selector", selector);
              const output = yield* runAstGrepEffect(args, cwd);
              return {
                content: output,
                metadata: { title: `ast-grep debug pattern · ${lang} · ${resolvedFormat}`, pattern, lang, format: resolvedFormat, selector },
              };
            }),
        });

        draft.add({
          name: "astgrep_test_pattern",
          description: testPatternDescription,
          input: TestPatternInput,
          options: { codemode: true },
          execute: ({ pattern, lang, code }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const output = yield* runAstGrepOnSnippet(
                ["run", "--pattern", pattern, "--lang", lang, "--json=compact"],
                lang,
                code,
                cwd,
              );
              return {
                content: withEmptyResultHint(output, EMPTY_PATTERN_TEST_RESULT_HINT),
                metadata: { title: `ast-grep test pattern · ${lang}`, pattern, lang },
              };
            }),
        });

        draft.add({
          name: "astgrep_test_rule",
          description: testRuleDescription,
          input: TestRuleInput,
          options: { codemode: true },
          execute: ({ rule, lang, code }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const fullRule = fullRuleFor(lang, rule);
              const output = yield* runAstGrepOnSnippet(
                ["scan", "--inline-rules", fullRule, "--json=compact"],
                lang,
                code,
                cwd,
              );
              return {
                content: withEmptyResultHint(output, EMPTY_RULE_TEST_RESULT_HINT),
                metadata: { title: `ast-grep test rule · ${lang}`, rule: fullRule, lang },
              };
            }),
        });

        draft.add({
          name: "astgrep_rule",
          description: ruleDescription,
          input: RuleInput,
          options: { codemode: true },
          execute: ({ rule, lang, path }, tool) =>
            Effect.gen(function* () {
              const cwd = sessionDirectory;
              const target = path && path.length > 0 ? path : cwd;
              const fullRule = fullRuleFor(lang, rule);
              const output = yield* runAstGrepEffect(
                ["scan", "--inline-rules", fullRule, "--json=compact", target],
                cwd,
              );
              return {
                content: withEmptyResultHint(output, EMPTY_RULE_RESULT_HINT),
                metadata: { title: `ast-grep rule · ${lang}`, rule: fullRule, lang, path: target },
              };
            }),
        });
      });
    }),
});
