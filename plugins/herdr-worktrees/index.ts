// Bridges OpenCode V2 worktrees with herdr workspaces.
//
// - OpenCode create  -> herdr `worktree.create` under the workspace that owns the source checkout,
//                       so the worktree shows up as a child workspace. Nothing is launched in it.
// - OpenCode remove  -> herdr `worktree.remove` (Git fallback when herdr no longer owns it).
// - herdr remove     -> sessions living in that directory are interrupted and moved back to the
//                       source checkout, then OpenCode's worktree inventory is refreshed.
//
// The strategy is only registered inside a herdr pane with a reachable socket; otherwise the
// bundled Git strategy stays the default.

import { Plugin } from "@opencode/plugin/effect";
import type { Session } from "@opencode/schema/session";
import { Worktree } from "@opencode/schema/worktree";
import type { AbsolutePath } from "@opencode/schema/schema";
import { Effect, Queue, Stream } from "effect";
import {
  HerdrError,
  errorMessage,
  isForceRequired,
  isInside,
  makeTransport,
  parsePorcelain,
  reachable,
  samePath,
  toCreateParams,
  toEntries,
  workspaceForCheckout,
  type Entry,
  type Transport,
  type WorkspaceInfo,
  type WorkspaceListResult,
  type WorktreeCreatedResult,
  type WorktreeListResult,
  type WorktreeRemovedEvent,
} from "./herdr.ts";

const STRATEGY_ID = "herdr";
const SUBSCRIPTIONS = ["worktree.removed"] as const;
const RESUBSCRIBE_DELAY = "5 seconds";

/** Directories this plugin instance removed itself, so we can ignore the matching herdr event. */
type Bookkeeping = { pendingRemoval: Set<string>; sessionDirectory: Map<string, string> };

type SessionEvent = {
  type: string;
  data?: { sessionID?: string; location?: { directory?: string } };
};

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stdout, stderr };
}

async function listWorkspaces(herdr: Transport): Promise<WorkspaceInfo[]> {
  const result = (await herdr.request("workspace.list", {})) as WorkspaceListResult;
  return result.workspaces;
}

async function herdrList(herdr: Transport, sourceDirectory: string): Promise<Entry[]> {
  const result = (await herdr.request("worktree.list", { cwd: sourceDirectory, trust_repository: true })) as WorktreeListResult;
  return toEntries(result);
}

async function gitList(sourceDirectory: string): Promise<Entry[]> {
  const out = await git(sourceDirectory, ["worktree", "list", "--porcelain"]);
  if (!out.ok) throw new Error(out.stderr.trim() || "git worktree list failed");
  return parsePorcelain(out.stdout);
}

/** `Effect.tryPromise` wraps thrown errors in an UnknownError whose `cause` is the original. */
function unwrap(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined && !(current instanceof HerdrError); depth += 1) {
    current = current.cause;
  }
  return current;
}

/**
 * Known gap: the server checks `instanceof` against its own bundled `Worktree.OperationError`
 * class, so `forceRequired` from a plugin currently surfaces as `null` in the HTTP response and the
 * TUI shows the "use --force" message instead of its confirm dialog. The message is still correct.
 */
function operationError(error: unknown): Worktree.OperationError {
  if (error instanceof Worktree.OperationError) return error;
  const cause = unwrap(error);
  return new Worktree.OperationError({ message: errorMessage(cause), forceRequired: isForceRequired(cause) });
}

export default Plugin.define({
  id: "herdr-worktrees",
  effect: (ctx) =>
    Effect.gen(function* () {
      const socketPath = Bun.env.HERDR_SOCKET_PATH;
      if (Bun.env.HERDR_ENV !== "1" || !socketPath || !(yield* Effect.promise(() => reachable(socketPath)))) {
        yield* Effect.logDebug("herdr-worktrees: not inside herdr or socket unreachable, leaving the Git strategy as default");
        return;
      }

      const herdr = makeTransport(socketPath);
      const here = ctx.location.directory;
      const books: Bookkeeping = { pendingRemoval: new Set(), sessionDirectory: new Map() };

      // Only the plugin instance whose location *is* the source checkout reacts to a herdr removal;
      // instances opened inside worktrees (or other projects) would otherwise move the same sessions.
      const ownsRoot = (repoRoot: string) => samePath(repoRoot, here) || samePath(repoRoot, ctx.location.project.directory);

      const create = Effect.fn("herdr-worktrees.create")(function* (input: { sourceDirectory: string; directory: string; branch?: string }) {
        const workspaces = yield* Effect.tryPromise(() => listWorkspaces(herdr));
        const source = workspaceForCheckout(workspaces, input.sourceDirectory);
        const params = toCreateParams(input, source);
        const created = (yield* Effect.tryPromise(() => herdr.request("worktree.create", { ...params, trust_repository: true }, 60_000))) as WorktreeCreatedResult;
        yield* Effect.logInfo(`herdr-worktrees: created ${created.worktree.path} as workspace ${created.workspace.workspace_id}`);
        return { directory: created.worktree.path };
      });

      const remove = Effect.fn("herdr-worktrees.remove")(function* (input: { directory: string; force: boolean }) {
        const workspaces = yield* Effect.tryPromise(() => listWorkspaces(herdr));
        const target = workspaceForCheckout(workspaces, input.directory);
        books.pendingRemoval.add(input.directory);
        if (target) {
          yield* Effect.tryPromise(() => herdr.request("worktree.remove", { workspace_id: target.workspace_id, force: input.force, trust_repository: true }, 60_000)).pipe(
            Effect.mapError(operationError),
            Effect.tapError(() => Effect.sync(() => books.pendingRemoval.delete(input.directory))),
          );
          return;
        }
        books.pendingRemoval.delete(input.directory); // Git fallback emits no herdr event
        // herdr no longer knows this worktree (workspace closed, herdr restarted). Fall back to Git so
        // OpenCode's inventory does not get stuck with an unremovable entry.
        const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory];
        const out = yield* Effect.promise(() => git(input.directory, args));
        if (!out.ok) {
          const message = out.stderr.trim() || "git worktree remove failed";
          return yield* new Worktree.OperationError({ message, forceRequired: /use --force|modified or untracked|locked/i.test(message) });
        }
      });

      const list = Effect.fn("herdr-worktrees.list")(function* (sourceDirectory: string) {
        return yield* Effect.tryPromise(() => herdrList(herdr, sourceDirectory)).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`herdr-worktrees: herdr list failed, using git (${errorMessage(error)})`).pipe(
              Effect.andThen(Effect.tryPromise(() => gitList(sourceDirectory))),
            ),
          ),
        );
      });

      yield* ctx.worktree.transform((editor) => {
        editor.add({
          id: STRATEGY_ID,
          create: (input) => create(input).pipe(Effect.mapError(operationError)),
          remove: (input) => remove(input).pipe(Effect.mapError(operationError)),
          list: (sourceDirectory) => list(sourceDirectory),
        });
      });

      // SAFETY: session ids and directories come straight from OpenCode and are passed back unchanged.
      const sid = (id: string) => id as Session.ID;
      const abs = (path: string) => path as AbsolutePath;

      const onRemoved = Effect.fn("herdr-worktrees.onRemoved")(function* (event: WorktreeRemovedEvent) {
        const directory = event.worktree.path;
        if (books.pendingRemoval.delete(directory)) return; // our own removal, OpenCode already knows
        // React from the source checkout's instance, or from the instance living in the dying worktree
        // when the source checkout has no OpenCode location open. A duplicate move is harmless.
        const inDyingWorktree = samePath(here, directory);
        const repoRoot = event.workspace?.worktree?.repo_root ?? (inDyingWorktree ? ctx.location.project.directory : undefined);
        if (!repoRoot || !(ownsRoot(repoRoot) || inDyingWorktree)) return;

        const sessions = [...books.sessionDirectory].filter(([, dir]) => isInside(dir, directory)).map(([id]) => id);
        for (const sessionID of sessions) {
          yield* ctx.session.interrupt({ sessionID: sid(sessionID) }).pipe(Effect.ignore);
          yield* ctx.session.move({ sessionID: sid(sessionID), directory: abs(repoRoot) }).pipe(
            Effect.catch((error) => Effect.logWarning(`herdr-worktrees: could not move ${sessionID} back to ${repoRoot}: ${errorMessage(error)}`)),
          );
        }
        yield* ctx.worktree.refresh({ location: { directory: here } }).pipe(
          Effect.catch((error) => Effect.logWarning(`herdr-worktrees: refresh failed after herdr removed ${directory}: ${errorMessage(error)}`)),
        );
        yield* Effect.logInfo(`herdr-worktrees: herdr removed ${directory}; ${sessions.length} session(s) moved back to ${repoRoot}`);
      });

      // The plugin API has no session.list, so remember where every session lives from the event
      // stream. The stream is global, which is what we want: sessions in a worktree report the
      // worktree directory as their location.
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const { type, data } = event as SessionEvent;
            const sessionID = data?.sessionID;
            if (!sessionID) return;
            switch (type) {
              case "session.created":
              case "session.moved": {
                const dir = data?.location?.directory;
                if (dir) books.sessionDirectory.set(sessionID, dir);
                return;
              }
              case "session.deleted":
                books.sessionDirectory.delete(sessionID);
                return;
            }
          }),
        ),
        Effect.forkScoped,
      );

      // One long-lived herdr subscription per plugin instance; reconnect when herdr drops it.
      const subscription = Stream.callback<WorktreeRemovedEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const sub = herdr.subscribe(SUBSCRIPTIONS, (event) => {
              if (event.data.type === "worktree_removed") Queue.offerUnsafe(queue, event.data as unknown as WorktreeRemovedEvent);
            });
            void sub.done.then(() => Queue.endUnsafe(queue));
            return sub;
          }),
          (sub) => Effect.sync(() => sub.stop()),
        ),
      );

      const loop = subscription.pipe(
        Stream.runForEach((event) => onRemoved(event).pipe(Effect.catchCause((cause) => Effect.logWarning(`herdr-worktrees: removal handler failed`, cause)))),
        Effect.andThen(Effect.logDebug("herdr-worktrees: herdr subscription closed, reconnecting")),
        Effect.andThen(Effect.sleep(RESUBSCRIBE_DELAY)),
        Effect.forever,
      );
      yield* Effect.forkScoped(loop);

      yield* Effect.logInfo(`herdr-worktrees: registered the herdr worktree strategy for ${here}`);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("herdr-worktrees: setup failed, Git strategy stays active", cause))),
});
