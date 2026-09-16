# Session Retro plugin — spec

Status: agreed design, pre-implementation. Probe results verified against a live
V2 server (`opencode2 v0.0.0-beta-19296`) on 2026-09-08.

## Goal

Detect friction in OpenCode sessions (blocked, interrupted, flailing, tool
storms, user corrections), persist it to SQLite, and expose it so the harness
(AGENTS.md, skills, prompts, permissions, plugins) can be improved from data.

## Principles

1. **Nothing costs tokens without a yes.** Deterministic metrics run silently on
   every turn. LLM analysis runs only after explicit confirmation, or when the
   user has stored "always run for this project".
2. **Never interrupt a turn.** No dialog, toast, or auto-run while the focused
   session (or the due session) is executing.
3. **Recording is write-only during turns.** No reads of `session.context()`
   while a turn is in flight; only on analysis.

## Facts established by the probe

- There is no session "end" event. Turn boundaries are
  `session.execution.started` → `session.execution.{succeeded,failed,interrupted}`.
  `session.deleted` is the only terminal event and is rare.
- `session.viewed` carries `{sessionID, idle}`; use it to re-ask for pending
  retros when the user returns to a session.
- `GET /api/session/{id}/context` (= `ctx.session.context`) returns
  `{data: Message[]}` where:
  - user: `{id, time.created, text, files, agents, type:"user"}`
  - assistant: `{id, time.{created,streamed,completed}, agent, model, content[],
    snapshot, finish, rawFinish, cost, tokens, error?}`
  - `finish` ∈ `tool-calls | stop | error`; interrupted steps show
    `finish:"error", error:{type:"aborted", message:"Step interrupted"}`
  - `content[]` items: `reasoning`, `text`, `tool` where tool =
    `{id, name, executed, state:{status, input, content[], metadata}}`.
    Tool state has **no timing**; durations must come from the
    `tool.hook("execute.before"/"execute.after")` pair, keyed by `Tool.CallID`.
- Subagent sessions are ordinary sessions with `Session.Info.parentID` set.
- Plugin layout `plugins/session-retro/{index.ts,tui.tsx,rpc.ts}` under the
  global config dir is auto-discovered for both halves; no `opencode.json` entry
  is required except to pass options.
- `ctx.generate.text({prompt, model?})` → `{text}`; no session, no tools, no
  history. Safe for the LLM pass (no recursion).
- TUI half: `data.on(eventType, cb)`, `data.session.status(id)` → `idle|running`,
  `ui.router.current()` → `{type:"home"} | {type:"session", sessionID} | plugin`,
  `ui.dialog.confirm/select`, `ui.toast.show`, `attention.notify`.

## Architecture

```
plugins/session-retro/
  index.ts    server half (Effect plugin, like the other two in this repo)
  tui.tsx     CLI half: asks the user and renders the report, never analyzes
  rpc.ts      shared contract
  db.ts       bun:sqlite schema + queries
  rules.ts    deterministic detectors
  analyze.ts  LLM prompt build + strict JSON parse
```

### Server half (`index.ts`)

State per session (in memory): current turn id, tool-call start times,
permission ask start times, counters. Durable state in `ctx.storage`:
`pending/<sessionID>` and `policy/<projectDir>` (`always | never`).

Event/hook wiring:

| Source | Action |
|---|---|
| `session.created` | upsert `session` row (id, parent_id, project_dir, title) |
| `session.execution.started` | open `turn`; cancel idle timer |
| `tool.hook execute.before` | remember `t0` by call id |
| `tool.hook execute.after` | insert `tool_call` (name, input hash, duration, status, error) |
| `permission.hook evaluate` (effect `ask`) | remember ask `t0` |
| permission reply / `session.execution.*` | accumulate `permission_wait_ms` |
| `session.retry.scheduled` | `retries++` on turn |
| `session.compaction.started` | `compactions++` on turn |
| `session.usage.recorded` / `session.step.ended` | tokens, cost, steps |
| `session.execution.{succeeded,failed,interrupted}` | close `turn` (outcome), run `rules.ts` on that turn, insert `friction(source=rule)`, start idle timer (`idleMinutes`, default 30) |
| idle timer fires | `storage.set(pending/<id>)`; emit rpc event `retro.due`; **no analysis** |
| `session.viewed` for a pending session | re-emit `retro.due` (TUI may have missed it) |
| plugin unload | flush in-memory counters to sqlite; no LLM |

Policy `always` for the project: on idle timer, run analysis directly
(session is idle by construction) instead of emitting `retro.due`.

RPC (`rpc.ts`):

```
methods:
  run     {sessionID}              → {runID, ranAt, findings: number, report} // waits, analyzes, returns Markdown
  skip    {sessionID}              → {}                          // clears pending
  later   {sessionID}              → {}                          // clears pending, resets idle timer
  policy  {projectDir, policy: "always"|"never"|"ask"} → {}
  pending {}                       → {sessions: [{sessionID, title, projectDir, turns, dueAt}]}
events:
  due     {sessionID, title, projectDir, turns, idleMinutes}
```

CLI command `/retro [pending|settings|skip|later|always|never]`: default = `run`
for the current session (resets timer and clears pending). The TUI calls the
server RPC and opens a scrollable, theme-aware rendered Markdown page in the
main content area; it does not post a synthetic transcript message or trigger
another model turn. On a retro report, `e` prompts for a project-relative or
absolute path and exports actionable Markdown. Existing files require overwrite
confirmation.

Tool `retro_query` (namespace `retro`, codemode on): `{sql}` read-only SELECT
against retro.db (reject anything not starting with `SELECT`/`WITH`; open the
DB `readonly`). `retro_summary {sessionID?}` returns the latest `retro_run` +
findings for a session. `retro_context {runID}` resolves the durable run handle
embedded in exported Markdown and returns its session row, turns, summarized
tool calls, and rule/LLM findings from SQLite.

### TUI half (`tui.tsx`)

```
pending: memory store of due sessions   (from retro.due + rpc pending() on connect)

Never open a confirm/select dialog when a retro becomes due. The reminder is a
persistent footer chip, not a toast or modal:

  prompt.footer.status  → "retro due · /retro" when this session is pending
  home.footer.status    → "N retro(s) due · /retro pending" when any are pending
  /retro                → suggested in the palette while the current session is due

/retro verbs:
  (none)   → rpc.run
  pending  → list pending
  settings → show policy / idle / db
  skip     → rpc.skip
  later    → rpc.later (clears pending, resets idle timer)
  always   → rpc.policy(always); rpc.run
  never    → rpc.policy(never); rpc.skip
```

No analysis, no sqlite, no LLM in the TUI half.

### Rule detectors (`rules.ts`)

Run on the closed turn's `tool_call` rows and events:

| type | condition |
|---|---|
| `flailing` | same tool + same input hash ≥ 3 in one turn |
| `blind_retry` | shell exits non-zero and the next shell input hash is identical |
| `tool_storm` | tool calls in turn > max(20, p90 for this agent over history) |
| `blocked` | `permission_wait_ms` > 60 000 |
| `interrupted` | outcome = interrupted |
| `provider_retry` | retries > 0 (severity low, tagged not-harness) |
| `compaction` | compactions > 0 |
| `shell_for_search` | shell input matches `\b(rg|grep|ast-grep|sg|find)\b` while tools `grep`/`glob`/`astgrep_*` exist |

### LLM analysis (`analyze.ts`)

Input: `session.context()` compressed to user text, assistant text, and one
line per tool call `(#n tool name status inputSummary)`; tool output bodies
dropped; reasoning dropped. Rule findings appended as hints. Prompt asks for
JSON only:

```json
{"findings":[{"type":"user_correction|unnecessary_question|false_done|instruction_violated|wrong_tool|scope_creep|other",
  "turn":3,"severity":"low|medium|high","evidence":"…","root_cause":"…",
  "harness_fix":{"target":"agents_md|skill|prompt|permission|plugin|tool|none","suggestion":"…"}}],
 "summary":"…"}
```

Model: `options.analysisModel` if set, else the catalog default. Parse
strictly; on failure store raw text in `retro_run.raw_output` and `status=parse_error`.

### SQLite (`db.ts`, `bun:sqlite`)

Path: `options.dbPath` else `<data>/session-retro.db` (data dir from
`opencode2 debug paths`; `~/.local/share/opencode`). WAL mode.

```sql
session   (id PK, parent_id, project_dir, agent, model, title, first_seen, last_seen)
turn      (id PK, session_id, idx, started, ended, outcome, steps, tool_calls,
           tokens_in, tokens_out, tokens_reasoning, cost, permission_wait_ms,
           retries, compactions)
tool_call (id PK, turn_id, tool, input_hash, input_summary, duration_ms, status, error)
friction  (id PK, session_id, turn_id, source, type, severity, evidence,
           root_cause, fix_target, fix_suggestion, run_id)
retro_run (id PK, session_id, ran_at, trigger, model, tokens, status, summary, raw_output)
policy    (project_dir PK, policy)

views: v_worst_sessions, v_tool_error_rates, v_friction_by_type, v_harness_fixes
```

### Options (`opencode.json`, optional)

```jsonc
{ "package": "./plugins/session-retro",
  "options": { "idleMinutes": 30, "analysisModel": { "providerID": "…", "id": "…" },
               "analysisTimeoutSeconds": 180, "analysisPromptPath": null,
               "includeSubagents": true, "dbPath": null } }
```

## Implementation notes (deviations, 2026-09-08)

- **Policy lives in SQLite** (`policy` table), not `ctx.storage`; only `pending/<id>`
  uses storage. `retro_query` can then read policy alongside findings.
- **Analysis model**: `options.analysisModel` → the session's own model → catalog
  default. The catalog default (`opencode` free tier) is rejected outside the TUI.
  `options.analysisTimeoutSeconds` (default 180) bounds the LLM call.
- **`session.wait`** hangs on an already-idle session in beta-19296, so it is only
  called when the session looks running, capped at 10 min; on timeout the run is
  refused rather than reading `session.context()` mid-turn.
- **Synthetic `/retro` posts** use `resume: false`; otherwise the server schedules
  another model turn after each post. Superseded in the 2026-09-09 display fix below.
- **Location filtering**: the plugin is instantiated once per open project and every
  instance sees the global event stream; each instance only records sessions whose
  location matches `ctx.location.directory`.
- **Permission wait** is measured from `permission.hook evaluate` (effect `ask`) to
  `permission.replied` or turn end; the hook exposes no request id.
- **JSON parse** tolerates a ```` ```json ```` fence and surrounding prose but is
  strict on shape (enum values, integer `turn`, required keys).
- Extra `session.renamed`/`session.deleted` handling keeps titles fresh and drops
  timers/pending for deleted sessions.
- TUI half imports `@opencode/plugin/tui` (Promise API); there is no Effect
  entrypoint for CLI plugins.

## Implementation notes (review, 2026-09-09)

- **Bun-only runtime modules.** No `node:*` imports: `Bun.CryptoHasher` for hashing,
  `Bun.env` for `HOME`/`XDG_DATA_HOME`, string ops for the one path. Bun has no native
  `mkdir`, so `openDb` is `async` and creates the parent directory via
  `Bun.write(path, "")` guarded by `Bun.file(path).exists()` (a zero-byte file is a
  valid empty SQLite database; the guard prevents truncating a live one).
- **Hooks never throw.** `execute.before` and `permission.evaluate` are wrapped in
  `swallow` like `execute.after`; an unhandled error in a hook blocks every tool call
  in the session (observed during the review when `openDb` became async mid-reload).
- **`running` guard** uses `Effect.ensuring`; `try/finally` inside `Effect.gen` does
  not run on a failed `yield*`, which left sessions permanently "already running".
- **`v_worst_sessions`** aggregates turns and frictions in subqueries (the double
  `LEFT JOIN` multiplied counts). Views are `drop`+`create` on migrate so definition
  changes reach existing databases.
- **`retro_query` guard** is first-keyword + single-statement only; the `readonly` +
  `query_only` connection is what actually blocks writes (verified against a CTE-wrapped
  `delete`). The old keyword blocklist rejected `select replace(...)`.
- **Analysis shape** is one Effect `Schema` (`Analysis` in `analyze.ts`); `parseAnalysis`
  decodes with it and `outputShapeBlock()` renders the same enums into the prompt.
  `ctx.generate.text` is `{prompt, model?} → {text}` with no structured-output mode in
  the current SDK, so this is the closest available equivalent.
- **`options.analysisPromptPath`**: optional template file with `{{transcript}}` and
  `{{hints}}` placeholders; the output-shape instructions are always appended by
  `buildPrompt`, so a custom prompt cannot desync from the parser.

## Implementation notes (display fix, 2026-09-09)

- `/retro` is a CLI/TUI keymap slash command, not a server prompt command. The
  server's `session.synthetic({ resume: false })` admits an inbox item but does not
  guarantee immediate visible message content; this produced blank "Session retro"
  rows in the transcript. The CLI now invokes the RPC and renders its report on a
  scrollable plugin page, while `pending` and `settings` use the same direct UI path.
- TUI `keymap.layer()` uses Solid hooks and must be called from a rendered owner.
  The plugin mounts the global `/retro` layer through the `app` slot; calling it
  directly from `setup()` leaves the command unreachable.

## Implementation notes (due reminder, 2026-09-16)

- The idle-due prompt is a footer status chip, not `dialog.select`. A modal
  after every idle period interrupted composing; the chip stays until
  `/retro`, `/retro skip`, or `/retro later`.
- `later` now clears server pending before resetting the idle timer so
  `session.viewed` cannot immediately re-due a snoozed session. If a turn is
  already running, it does not start a new timer; `onTurnEnded` will.

## Out of scope (v1)

- Cross-session dedupe of harness fixes beyond the `v_harness_fixes` view.
- Auto-editing AGENTS.md from findings.
- Headless auto-run: without a TUI, sessions only accumulate in `pending`.

## Verification plan

1. `bunx tsc --noEmit …` over the new files (add to the AGENTS.md command).
2. Restart opencode; run a short session; confirm `turn`/`tool_call` rows via
   `sqlite3 ~/.local/share/opencode/session-retro.db`.
3. Set `idleMinutes: 1`, wait, confirm the footer chip appears and no dialog or
   due-toast interrupts; confirm `/retro skip` and `/retro later` clear it.
4. `/retro` on a session → `retro_run` + `friction(source=llm)` rows.
5. `retro_query {sql: "select * from v_harness_fixes"}` from an agent.
