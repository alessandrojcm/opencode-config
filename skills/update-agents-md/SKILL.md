---
name: update-agents-md
description: Instructs agents on how to maintain and update the AGENTS.md file after sessions. Use when an agent needs to append new conventions, stack decisions, or workflow notes to AGENTS.md, or when refactoring existing agent notes into a modular structure.
---

# Update AGENTS.md

## Quick start

After completing a task that reveals a new convention, boundary, or workflow rule, append it to AGENTS.md or the appropriate sub-document. Do not let knowledge disappear with the session.

## Workflows

### 1. Post-session update

- [ ] Identify any new decisions, constraints, or patterns discovered during the session.
- [ ] Determine if the note belongs in an existing sub-document or requires a new one.
- [ ] Append the note using the same bullet style as existing entries.
- [ ] Keep entries atomic: one idea per bullet.
- [ ] If a new note contradicts an old one, update the old note in-place. AGENTS.md reflects current conventions only; do not preserve historical markers or changelog entries.

### 2. Refactor into modular sub-docs

AGENTS.md must stay short. When a section grows beyond ~50 lines, extract it:

- [ ] Create a focused sub-document under `docs/agents/` (e.g., `docs/agents/testing.md`, `docs/agents/running.md`).
- [ ] Move the detailed bullets into the sub-document.
- [ ] Replace the inline content in AGENTS.md with a link:
  `See [docs/agents/<name>.md](docs/agents/<name>.md).`
- [ ] Ensure the sub-document has a clear heading matching its topic.

### 3. Existing sub-document categories

| Topic | File |
|-------|------|
| Issue tracker | `docs/agents/issue-tracker.md` |
| Triage labels | `docs/agents/triage-labels.md` |
| Domain docs | `docs/agents/domain.md` |

Add new categories as needed under `docs/agents/`.

## Rules

- AGENTS.md is an index, not a dump. If a section exceeds 50 lines, it belongs in a sub-document.
- Use consistent bullet style (`- ` at the start of each line).
- Prefer linking over inlining. The AGENTS.md table of contents should fit on one screen.
- Update AGENTS.md **last**, after all code changes are complete, so notes reflect the final state.
- When removing obsolete notes, do not leave orphaned links in AGENTS.md. If a sub-document becomes empty, delete it and remove the link.

## Examples

### Good: Extracting an overgrown section

AGENTS.md before (52 lines under `## Testing`):

```markdown
## Testing

- Run all tests with `go test ./...` or `make test`.
- `make build` compiles all packages with `go build ./...`.
- `make build-whisper` compiles all packages including whisper.cpp CGO code...
- ... (49 more lines)
```

AGENTS.md after:

```markdown
## Testing

See [docs/agents/testing.md](docs/agents/testing.md).
```

Content moved to `docs/agents/testing.md` with the original heading preserved.

### Bad: Appending endlessly to AGENTS.md

```markdown
## Testing

- Run all tests with `go test ./...` or `make test`.
- `make build` compiles all packages with `go build ./...`.
- `make build-whisper` compiles all packages including whisper.cpp CGO code...
- ... (120 more lines)
```

This bloats the index and makes it hard to scan. Extract at ~50 lines.
