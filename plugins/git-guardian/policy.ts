// Match `git` as the first word or after common shell separators/prefixes.
// This also catches constructs such as `cd app && git status` and piped commands.
const GIT_PATTERN = /(^|[;&|\n]|`|\$\()\s*(?:command\s+|exec\s+)?git\b/;

export function isDirectGitCommand(resource: string): boolean {
  return GIT_PATTERN.test(resource.trim());
}

export function buildGitButlerInstructions(isGitRepository: boolean): string {
  const repositoryGuidance = isGitRepository
    ? "This directory is already a Git repository. GitButler needs no separate initialization step for an existing Git repository. Use `but` for version-control operations. If a `but` command reports that no target branch is configured, inspect the available branches and set the actual default with `but config target <branch>`; do not run `but init` in an existing repository."
    : "This directory is not currently a Git repository. For a task that changes or tracks project files, initialize it first with `but init` rather than `git init`. Do not create a repository for read-only questions.";

  return [
    "Git Guardian policy: use GitButler (`but`) as this project's version-control interface. Do not invoke raw `git` commands through the shell; Git Guardian blocks them. This applies in linked worktrees too.",
    repositoryGuidance,
    "Use the `but` skill for command syntax and workflows. GitButler operations produce normal Git branches and commits that can be shared through the project's existing remote.",
  ].join("\n\n");
}
