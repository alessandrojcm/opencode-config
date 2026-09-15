// herdr plugin: escape hatch for nono sandboxes that OpenCode/herdr-worktrees did not clean up.
//
// Correlates `nono ps --json` with `herdr workspace list`: a sandbox whose workdir is a herdr
// workspace checkout is "attached"; one whose workdir no longer has a workspace (worktree removed,
// herdr restarted, ...) is an "orphan". Modes:
//   --interactive   fzf picker in a herdr popup; Enter = stop selected, ctrl-d = stop + remove the
//                   worktree (herdr → OpenCode refresh for attached, git for orphans; y/N on dirty),
//                   ctrl-o = stop all orphans
//   --open          action wrapper that opens the popup (herdr keybinds can only target actions)
//   --status        one short line for a `ui.tab_bar_right` command entry (empty when none run)
//   --summary       one-line herdr notification + table on stdout (for the plugin log)
//   --stop-orphans  stop every orphan, no prompt

import { correlate, formatTable, type Row } from "./lib.ts";

const herdrBin = Bun.env.HERDR_BIN_PATH ?? "herdr";

async function run(cmd: string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stdout, stderr };
}

async function load(): Promise<Row[]> {
  const [ps, ws] = await Promise.all([run(["nono", "ps", "--json"]), run([herdrBin, "workspace", "list"])]);
  if (!ps.ok) throw new Error(`nono ps failed: ${ps.stderr.trim()}`);
  if (!ws.ok) throw new Error(`herdr workspace list failed: ${ws.stderr.trim()}`);
  return correlate(JSON.parse(ps.stdout), JSON.parse(ws.stdout).result.workspaces);
}

async function stop(rows: Row[]): Promise<string[]> {
  const out: string[] = [];
  for (const row of rows) {
    const res = await run(["nono", "stop", row.session_id]);
    out.push(res.ok ? `stopped ${row.session_id} (${row.name})` : `FAILED ${row.session_id}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return out;
}

async function notify(message: string): Promise<void> {
  await run([herdrBin, "notification", "show", message]).catch(() => undefined);
}

/** y/N prompt on the popup's own terminal. Anything but y/Y is "no". */
async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) return /^y$/i.test(line.trim());
  return false;
}

/**
 * Remove the worktree behind a (now stopped) sandbox.
 * - Attached: `herdr worktree remove` — herdr closes the workspace and emits `worktree_removed`,
 *   which the herdr-worktrees OpenCode plugin turns into a `worktree.refresh`, so OpenCode's
 *   inventory follows without a separate API call.
 * - Orphan: no workspace exists, so only the Git worktree on disk can be removed.
 * Both refuse a dirty tree unless the user confirms `--force`.
 */
async function removeWorktree(row: Row): Promise<string> {
  const attempt = async (force: boolean) => {
    if (row.workspace) {
      const args = [herdrBin, "worktree", "remove", "--workspace", row.workspace.id, ...(force ? ["--force"] : [])];
      return run(args);
    }
    const inside = await run(["git", "-C", row.workdir, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok) return { ok: false, stdout: "", stderr: `${row.workdir} is not a git worktree (already removed?)` };
    return run(["git", "-C", row.workdir, "worktree", "remove", ...(force ? ["--force"] : []), row.workdir]);
  };
  const first = await attempt(false);
  if (first.ok) return `removed worktree ${row.workdir}`;
  const message = (first.stderr || first.stdout).trim();
  const dirty = /dirty_worktree_requires_force|use --force|modified or untracked|locked/i.test(message);
  if (!dirty) return `FAILED to remove ${row.workdir}: ${message}`;
  console.log(`${row.workdir} has uncommitted changes.`);
  if (!(await confirm("Force-remove and lose them?"))) return `kept worktree ${row.workdir}`;
  const forced = await attempt(true);
  return forced.ok ? `force-removed worktree ${row.workdir}` : `FAILED to force-remove ${row.workdir}: ${(forced.stderr || forced.stdout).trim()}`;
}

async function interactive(): Promise<void> {
  for (;;) {
    const rows = await load();
    if (rows.length === 0) {
      console.log("No running nono sandboxes.");
      return;
    }
    const orphans = rows.filter((r) => r.orphan);
    const header = `Enter: stop · ctrl-d: stop + remove worktree · ctrl-o: stop ${orphans.length} orphan(s) · tab: multi-select · esc: close`;
    const lines = formatTable(rows);
    const fzf = Bun.spawn(
      ["fzf", "--multi", "--header-lines=1", "--header", header, "--layout=reverse", "--no-sort", "--expect=ctrl-o,ctrl-d", "--prompt", "sandbox> ", "--with-nth=1.."],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    fzf.stdin.write(lines.join("\n"));
    fzf.stdin.end();
    const output = await new Response(fzf.stdout).text();
    const code = await fzf.exited;
    if (code === 130 || code === 1) return; // esc / no match
    // With --expect, fzf prints the pressed key on the first line (empty for Enter), then the rows.
    const [key = "", ...rest] = output.split("\n");
    const picked = rest.filter(Boolean);
    const targets = key === "ctrl-o" ? orphans : rows.filter((r) => picked.some((line) => line.startsWith(r.session_id)));
    if (targets.length === 0) {
      console.log("nothing selected");
      await Bun.sleep(800);
      continue;
    }
    const results = await stop(targets);
    console.log(results.join("\n"));
    if (key === "ctrl-d") {
      await Bun.sleep(1500); // let nono's supervisor finish tearing down (rollback snapshot, audit) before touching the tree
      for (const row of targets) console.log(await removeWorktree(row));
      console.log("\npress Enter to continue");
      for await (const _ of console) break;
      continue;
    }
    await Bun.sleep(1200);
  }
}

async function summary(): Promise<void> {
  const rows = await load();
  const orphans = rows.filter((r) => r.orphan).length;
  console.log(formatTable(rows).join("\n"));
  await notify(rows.length === 0 ? "nono: no running sandboxes" : `nono: ${rows.length} sandbox(es), ${orphans} orphan(s)`);
}

async function stopOrphans(): Promise<void> {
  const rows = await load();
  const orphans = rows.filter((r) => r.orphan);
  if (orphans.length === 0) return notify("nono: no orphan sandboxes");
  const results = await stop(orphans);
  console.log(results.join("\n"));
  await notify(`nono: stopped ${results.filter((r) => r.startsWith("stopped")).length}/${orphans.length} orphan sandbox(es)`);
}

async function open(): Promise<void> {
  const res = await run([herdrBin, "plugin", "pane", "open", "--plugin", Bun.env.HERDR_PLUGIN_ID ?? "cuppari.nono-sandboxes", "--entrypoint", "list"]);
  if (!res.ok) throw new Error(res.stderr.trim() || "plugin pane open failed");
}

/** One line for `ui.tab_bar_right` command entries; empty output hides the entry when nothing runs. */
async function status(): Promise<void> {
  const rows = await load();
  if (rows.length === 0) return;
  const orphans = rows.filter((r) => r.orphan).length;
  console.log(orphans > 0 ? `⛨ ${rows.length} sandbox · ${orphans} orphan!` : `⛨ ${rows.length} sandbox`);
}

const mode = Bun.argv[2] ?? "--summary";
const modes: Record<string, () => Promise<void>> = { "--interactive": interactive, "--stop-orphans": stopOrphans, "--open": open, "--status": status, "--summary": summary };
const main = modes[mode] ?? summary;
main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  await notify(`nono sandboxes: ${message}`);
  if (mode === "--interactive") {
    console.error("\npress Enter to close");
    for await (const _ of console) break;
  }
  process.exit(1);
});
