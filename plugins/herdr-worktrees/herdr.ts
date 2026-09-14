// Minimal client for the herdr socket API (newline-delimited JSON over a unix socket)
// plus the pure mapping helpers the plugin needs. Everything that touches the socket
// lives here so index.ts stays about OpenCode lifecycle.

export interface HerdrErrorBody {
  code: string;
  message: string;
}

export class HerdrError extends Error {
  readonly code: string;
  constructor(body: HerdrErrorBody) {
    super(body.message);
    this.name = "HerdrError";
    this.code = body.code;
  }
}

export interface WorkspaceWorktreeInfo {
  checkout_path: string;
  is_linked_worktree: boolean;
  repo_key: string;
  repo_name: string;
  repo_root: string;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  worktree?: WorkspaceWorktreeInfo | null;
}

export interface WorktreeInfo {
  path: string;
  branch?: string | null;
  is_linked_worktree: boolean;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  label: string;
  open_workspace_id?: string | null;
}

export interface WorktreeListResult {
  type: "worktree_list";
  source: { repo_root: string; source_checkout_path: string; source_workspace_id?: string | null };
  worktrees: WorktreeInfo[];
}

export interface WorktreeCreatedResult {
  type: "worktree_created";
  workspace: WorkspaceInfo;
  worktree: WorktreeInfo;
}

export interface WorktreeRemovedResult {
  type: "worktree_removed";
  forced: boolean;
  path: string;
  workspace_id: string;
}

export interface WorkspaceListResult {
  type: "workspace_list";
  workspaces: WorkspaceInfo[];
}

/** Event envelope delivered on an `events.subscribe` connection. */
export interface HerdrEvent {
  event: string;
  data: { type: string; [key: string]: unknown };
}

export interface WorktreeRemovedEvent {
  type: "worktree_removed";
  forced: boolean;
  workspace_id: string;
  workspace?: WorkspaceInfo | null;
  worktree: WorktreeInfo;
}

export interface WorktreeCreatedEvent {
  type: "worktree_created" | "worktree_opened";
  workspace: WorkspaceInfo;
  worktree: WorktreeInfo;
}

type ResponseLine =
  | { id: string; result: unknown }
  | { id: string; error: HerdrErrorBody };

/** Split a buffer into complete lines; returns the lines and the unterminated remainder. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}

export function parseResponse(line: string): { result: unknown } | { error: HerdrErrorBody } {
  const parsed = JSON.parse(line) as ResponseLine;
  if ("error" in parsed && parsed.error) return { error: parsed.error };
  return { result: (parsed as { result: unknown }).result };
}

export function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(a) === stripTrailingSlash(b);
}

export function isInside(path: string, root: string): boolean {
  const r = stripTrailingSlash(root);
  const p = stripTrailingSlash(path);
  return p === r || p.startsWith(`${r}/`);
}

export function basename(path: string): string {
  const parts = stripTrailingSlash(path).split("/");
  return parts[parts.length - 1] ?? path;
}

/** Find the herdr workspace whose checkout is `directory`. */
export function workspaceForCheckout(workspaces: readonly WorkspaceInfo[], directory: string): WorkspaceInfo | undefined {
  return workspaces.find((w) => w.worktree && samePath(w.worktree.checkout_path, directory));
}

export interface CreateParams {
  workspace_id?: string;
  cwd?: string;
  path: string;
  branch: string;
  base?: string;
  label: string;
  focus: false;
}

/**
 * Translate OpenCode's create input into herdr's. OpenCode's `branch` is a *starting ref*, which is
 * herdr's `base`; the new branch takes the worktree's name so it is recognisable in `git branch`.
 */
export function toCreateParams(
  input: { sourceDirectory: string; directory: string; branch?: string },
  sourceWorkspace: WorkspaceInfo | undefined,
): CreateParams {
  const name = basename(input.directory);
  const params: CreateParams = { path: input.directory, branch: name, label: name, focus: false };
  if (sourceWorkspace) params.workspace_id = sourceWorkspace.workspace_id;
  else params.cwd = input.sourceDirectory;
  if (input.branch) params.base = input.branch;
  return params;
}

export type Entry = { directory: string; type: "root" | "worktree" };

export function toEntries(list: WorktreeListResult): Entry[] {
  return list.worktrees.map((w) => ({ directory: w.path, type: w.is_linked_worktree ? "worktree" : "root" }));
}

/** Parse `git worktree list --porcelain` output into strategy entries (fallback when herdr is gone). */
export function parsePorcelain(text: string): Entry[] {
  const entries: Entry[] = [];
  let first = true;
  for (const block of text.split(/\n\s*\n/)) {
    const line = block.split("\n").find((l) => l.startsWith("worktree "));
    if (!line) continue;
    entries.push({ directory: line.slice("worktree ".length).trim(), type: first ? "root" : "worktree" });
    first = false;
  }
  return entries;
}

export const DIRTY_CODE = "dirty_worktree_requires_force";

export function isForceRequired(error: unknown): boolean {
  return error instanceof HerdrError && error.code === DIRTY_CODE;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

// --- socket transport -----------------------------------------------------------------------

export interface Transport {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Opens a subscription; resolves when the connection closes. `stop()` closes it early. */
  subscribe(types: readonly string[], onEvent: (event: HerdrEvent) => void): { done: Promise<void>; stop: () => void };
}

/** `Bun.file(path).exists()` is false for unix sockets, so probe the server with a `ping` instead. */
export async function reachable(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    await makeTransport(socketPath).request("ping", {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

let requestCounter = 0;

export function makeTransport(socketPath: string, source = "opencode:herdr-worktrees"): Transport {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  function request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    requestCounter += 1;
    const id = `${source}:${requestCounter}:${Date.now()}`;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new HerdrError({ code: "timeout", message: `herdr ${method} timed out after ${timeoutMs}ms` }))), timeoutMs);
      Bun.connect({
        unix: endpoint,
        socket: {
          open(socket) {
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
          },
          data(socket, chunk) {
            buffer += chunk.toString();
            const { lines, rest } = splitLines(buffer);
            buffer = rest;
            for (const line of lines) {
              let parsed: ReturnType<typeof parseResponse>;
              try {
                parsed = parseResponse(line);
              } catch {
                continue;
              }
              finish(() => ("error" in parsed ? reject(new HerdrError(parsed.error)) : resolve(parsed.result)));
              socket.end();
              return;
            }
          },
          error(_socket, error) {
            finish(() => reject(error));
          },
          close() {
            finish(() => reject(new HerdrError({ code: "closed", message: `herdr closed the connection during ${method}` })));
          },
          connectError(_socket, error) {
            finish(() => reject(error));
          },
        },
      }).catch((error) => finish(() => reject(error)));
    });
  }

  function subscribe(types: readonly string[], onEvent: (event: HerdrEvent) => void) {
    let buffer = "";
    let close: (() => void) | undefined;
    let stopped = false;
    const done = new Promise<void>((resolve) => {
      const settle = () => resolve();
      Bun.connect({
        unix: endpoint,
        socket: {
          open(socket) {
            close = () => socket.end();
            if (stopped) socket.end();
            socket.write(
              `${JSON.stringify({
                id: `${source}:subscribe:${Date.now()}`,
                method: "events.subscribe",
                params: { subscriptions: types.map((type) => ({ type })) },
              })}\n`,
            );
          },
          data(_socket, chunk) {
            buffer += chunk.toString();
            const { lines, rest } = splitLines(buffer);
            buffer = rest;
            for (const line of lines) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                continue;
              }
              if (parsed && typeof parsed === "object" && "data" in parsed && "event" in parsed) onEvent(parsed as HerdrEvent);
            }
          },
          error: settle,
          close: settle,
          connectError: settle,
        },
      }).catch(settle);
    });
    return {
      done,
      stop() {
        stopped = true;
        close?.();
      },
    };
  }

  return { request, subscribe };
}
