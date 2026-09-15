// Pure helpers for the nono-sandboxes herdr plugin (kept separate so they can be unit tested).

export interface NonoSession {
  session_id: string;
  name: string;
  status: string;
  attachment: string;
  started: string;
  command: string[];
  profile: string;
  workdir: string;
  child_pid?: number | null;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  worktree?: { checkout_path: string } | null;
}

export interface Row {
  session_id: string;
  name: string;
  status: string;
  attachment: string;
  age: string;
  command: string;
  profile: string;
  workdir: string;
  /** herdr workspace whose checkout is this workdir; absent for orphans. */
  workspace?: { id: string; label: string };
  orphan: boolean;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function formatAge(startedIso: string, now = Date.now()): string {
  const started = Date.parse(startedIso);
  if (Number.isNaN(started)) return "?";
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * Join sandboxes with herdr workspaces by workdir. Only running sessions are kept; a session whose
 * workdir has no workspace is an orphan (its worktree was removed, or herdr forgot the workspace).
 */
export function correlate(sessions: NonoSession[], workspaces: HerdrWorkspace[], now = Date.now()): Row[] {
  const byCheckout = new Map<string, HerdrWorkspace>();
  for (const w of workspaces) if (w.worktree) byCheckout.set(stripTrailingSlash(w.worktree.checkout_path), w);
  return sessions
    .filter((s) => s.status === "running")
    .map((s) => {
      const ws = byCheckout.get(stripTrailingSlash(s.workdir));
      return {
        session_id: s.session_id,
        name: s.name,
        status: s.status,
        attachment: s.attachment,
        age: formatAge(s.started, now),
        command: s.command.join(" "),
        profile: s.profile,
        workdir: s.workdir,
        workspace: ws ? { id: ws.workspace_id, label: ws.label } : undefined,
        orphan: !ws,
      };
    })
    .sort((a, b) => Number(b.orphan) - Number(a.orphan) || a.workdir.localeCompare(b.workdir));
}

function shorten(path: string, max: number): string {
  const home = Bun.env.HOME;
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

/** First line is a header; every following line starts with the session id so a picker can map back. */
export function formatTable(rows: Row[]): string[] {
  const cols = ["SESSION", "STATE", "AGE", "WORKSPACE", "WORKDIR", "COMMAND"];
  const data = rows.map((r) => [
    r.session_id,
    r.orphan ? "ORPHAN" : r.attachment,
    r.age,
    r.workspace ? `${r.workspace.id} ${r.workspace.label}` : "-",
    shorten(r.workdir, 48),
    r.command.length > 40 ? `${r.command.slice(0, 39)}…` : r.command,
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(cols), ...data.map(line)];
}
