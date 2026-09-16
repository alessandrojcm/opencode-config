export type RetroCommand =
  | { kind: "run" }
  | { kind: "pending" }
  | { kind: "settings" }
  | { kind: "skip" }
  | { kind: "later" }
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "unknown"; arg: string };

const VERBS = new Set(["pending", "settings", "skip", "later", "always", "never"]);

export function parseRetroCommand(input?: string): RetroCommand {
  const arg = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (arg === "") return { kind: "run" };
  if (VERBS.has(arg)) return { kind: arg as Exclude<RetroCommand, { kind: "unknown" }>["kind"] };
  return { kind: "unknown", arg };
}

export function promptDueLabel(sessionID: string | undefined, pendingIDs: readonly string[]): string | undefined {
  if (!sessionID || !pendingIDs.includes(sessionID)) return undefined;
  return "retro due · /retro";
}

export function homeDueLabel(count: number): string | undefined {
  if (count <= 0) return undefined;
  if (count === 1) return "1 retro due · /retro pending";
  return `${count} retros due · /retro pending`;
}
