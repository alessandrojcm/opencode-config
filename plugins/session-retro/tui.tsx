/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { Plugin } from "@opencode-ai/plugin/tui";
import { defaultRetroExportPath, resolveMarkdownExportPath, writeMarkdownExport } from "./report.ts";
import { SessionRetro, type DueEvent, type PendingSession, type Policy } from "./rpc.ts";

type RunResult = { runID: string; ranAt: number; findings: number; report: string };
type SettingsResult = { projectDir: string; policy: Policy; idleMinutes: number; dbPath: string };

type Choice = "run" | "skip" | "later" | "always" | "never";
type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>;
type ReportPageData = {
  title: string;
  report: string;
  sessionID?: string;
  exportPath?: string;
  returnRoute: Route;
};

const ASK_GRACE_MS = 2_000;
const REPORT_ROUTE = "session-retro-report";

function ReportPage(props: { context: Plugin.Context; data?: Record<string, any> }) {
  const theme = props.context.theme;
  const data = props.data as ReportPageData | undefined;
  let scroll: ScrollBoxRenderable | undefined;

  const close = () => props.context.ui.router.navigate(data?.returnRoute ?? { type: "home" });
  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    props.context.ui.toast.show({ title: "Session retro", message, variant });
  const exportReport = async () => {
    if (!data?.exportPath) return;
    const projectDir = props.context.location?.directory ?? props.context.data.location.default().directory;
    const requested = await props.context.ui.dialog.prompt({
      title: "Export retro to Markdown",
      description: "Relative paths are resolved from the current project.",
      value: data.exportPath,
      placeholder: "session-retros/retro.md",
    });
    if (requested === undefined) return;
    try {
      const path = resolveMarkdownExportPath(requested, projectDir);
      if (await Bun.file(path).exists()) {
        const overwrite = await props.context.ui.dialog.confirm({
          title: "Overwrite existing file?",
          message: props.context.ui.format.path(path),
          label: { confirm: "Overwrite", cancel: "Cancel" },
        });
        if (!overwrite) return;
      }
      await writeMarkdownExport(path, data.report);
      toast(`Exported to ${props.context.ui.format.path(path)}`, "success");
    } catch (error) {
      toast(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "escape", title: "Close session retro", group: "Session retro", run: close },
      { bind: "e", title: "Export Markdown", group: "Session retro", enabled: data?.exportPath !== undefined, run: exportReport },
      { bind: "up,k", title: "Scroll up", group: "Session retro", run: () => scroll?.scrollBy(-1) },
      { bind: "down,j", title: "Scroll down", group: "Session retro", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "Previous page", group: "Session retro", run: () => scroll?.scrollBy(-1, "viewport") },
      { bind: "pagedown", title: "Next page", group: "Session retro", run: () => scroll?.scrollBy(1, "viewport") },
      { bind: "home", title: "Start of report", group: "Session retro", run: () => scroll?.scrollTo(0) },
      { bind: "end", title: "End of report", group: "Session retro", run: () => scroll?.scrollTo(Number.MAX_SAFE_INTEGER) },
    ],
  }));

  return (
    <box width="100%" height="100%" minHeight={0} flexDirection="column" backgroundColor={theme.background.default}>
      <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="row">
        <text fg={theme.text.default}>{data?.title ?? "Session retro"}</text>
        <box flexGrow={1} />
        <text fg={theme.text.subdued}>{data?.exportPath ? "e export · esc back" : "esc back"}</text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        scrollX={false}
        scrollY={true}
        stickyScroll={false}
        viewportOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ visible: true, showArrows: true }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column">
          <text fg={theme.text.default} wrapMode="word" selectable={true}>
            {data?.report ?? "No retro report is available."}
          </text>
        </box>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text.subdued}>
          ↑/↓ or j/k scroll · pgup/pgdn page · home/end jump{data?.exportPath ? " · e export" : ""} · esc back
        </text>
      </box>
    </box>
  );
}

export default Plugin.define({
  id: "session-retro-tui",
  setup(context) {
    const rpc = context.client.rpc(SessionRetro);
    const pending = new Map<string, DueEvent>();
    const toasted = new Set<string>();
    let askOpenFor: string | undefined;
    let askTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanups: Array<() => void> = [];

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Session retro", message, variant });

    const fail = (what: string) => (e: unknown) => {
      toast(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    };

    function returnRoute(): Route {
      const route = context.ui.router.current();
      if (route.type === "plugin" && route.name === REPORT_ROUTE) {
        const previous = (route.data as Partial<ReportPageData> | undefined)?.returnRoute;
        if (previous) return previous;
      }
      if (route.type === "home") return { type: "home" };
      if (route.type === "session") return { type: "session", sessionID: route.sessionID };
      return { type: "plugin", id: route.id, name: route.name, ...(route.data ? { data: { ...route.data } } : {}) };
    }

    function showReport(title: string, report: string, sessionID: string | undefined, previous: Route, exportPath?: string) {
      context.ui.dialog.clear();
      context.ui.router.navigate({
        type: "plugin",
        name: REPORT_ROUTE,
        data: { title, report, sessionID, exportPath, returnRoute: previous } satisfies ReportPageData,
      });
    }

    function showable(): boolean {
      const route = context.ui.router.current();
      if (route.type === "home") return true;
      if (route.type === "session") return context.data.session.status(route.sessionID) === "idle";
      return true;
    }

    function drain() {
      if (!showable()) return;
      const route = context.ui.router.current();
      for (const [id, due] of pending) {
        if (!toasted.has(id)) {
          toasted.add(id);
          toast(`Retro due for "${due.title}" — /retro to run`, "info");
        }
        if (route.type === "session" && route.sessionID === id && askOpenFor === undefined && askTimer === undefined) {
          askTimer = setTimeout(() => {
            askTimer = undefined;
            void ask(id);
          }, ASK_GRACE_MS);
        }
      }
    }

    async function ask(id: string) {
      const due = pending.get(id);
      if (!due) return;
      if (context.data.session.status(id) !== "idle") return;
      const route = context.ui.router.current();
      if (route.type !== "session" || route.sessionID !== id) return;

      askOpenFor = id;
      let choice: Choice | undefined;
      try {
        choice = await context.ui.dialog.select<Choice>({
          title: `Run a retro on "${due.title}"?`,
          placeholder: `${due.turns} turns · idle ${due.idleMinutes} min · uses one LLM call`,
          options: [
            { title: "Run", value: "run", description: "Analyze this session now" },
            { title: "Skip", value: "skip", description: "Drop this retro" },
            { title: "Later", value: "later", description: "Ask again after the next idle period" },
            { title: "Always for this project", value: "always", description: "Run automatically when idle", category: "Policy" },
            { title: "Never for this project", value: "never", description: "Stop asking for this project", category: "Policy" },
          ],
        });
      } finally {
        askOpenFor = undefined;
      }
      // A turn starting while the dialog was open already removed it from pending and sent "later".
      if (!pending.has(id)) return;
      await act(id, due, choice ?? "later");
    }

    async function runRetro(id: string) {
      const previous = returnRoute();
      toast("Running retro…");
      await rpc
        .run({ sessionID: id })
        .then((raw) => {
          const r = raw as RunResult;
          toast(`Retro done: ${r.findings} finding${r.findings === 1 ? "" : "s"}.`, "success");
          showReport("Session retro", r.report, id, previous, defaultRetroExportPath(r.runID, r.ranAt));
        })
        .catch(fail("Retro"));
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current();
      if (route.type === "session") return route.sessionID;
      if (route.type === "plugin" && route.name === REPORT_ROUTE) return (route.data as Partial<ReportPageData> | undefined)?.sessionID;
      return undefined;
    }

    async function runCommand(input?: string) {
      const arg = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (arg === "pending") {
        const previous = returnRoute();
        const raw = (await rpc.pending({})) as { sessions: PendingSession[] };
        const message = raw.sessions.length
          ? raw.sessions.map((s) => `• ${s.title} (${s.sessionID})\n  ${s.turns} turns · ${s.projectDir}`).join("\n\n")
          : "No sessions with a pending retro.";
        showReport("Pending retros", message, currentSessionID(), previous);
        return;
      }

      const sessionID = currentSessionID();
      if (!sessionID) {
        toast("Open a session before running /retro.", "warning");
        return;
      }
      if (arg === "settings") {
        const previous = returnRoute();
        const settings = (await rpc.settings({ sessionID })) as SettingsResult;
        showReport(
          "Session retro settings",
          `Project: ${settings.projectDir}\nPolicy: ${settings.policy}\nIdle minutes: ${settings.idleMinutes}\nDatabase: ${settings.dbPath}`,
          sessionID,
          previous,
        );
        return;
      }
      await runRetro(sessionID);
    }

    // Keymap layers are Solid-owned: register from a rendered slot rather than setup(),
    // which runs outside a component owner and silently leaves the command unreachable.
    cleanups.push(
      context.ui.router.register({
        name: REPORT_ROUTE,
        render: (input) => <ReportPage context={context} data={input.data} />,
      }),
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "session-retro.run",
                title: "Run session retro",
                description: "Analyze this session for friction (or use pending/settings).",
                group: "Session retro",
                palette: true,
                slash: { name: "retro", arguments: true },
                run: (input) => runCommand(input).catch(fail("Retro command")),
              },
            ],
          }));
          return null;
        },
      }),
    );

    async function act(id: string, due: DueEvent, choice: Choice) {
      const setPolicy = (policy: Policy) => rpc.policy({ projectDir: due.projectDir, policy });
      switch (choice) {
        case "run":
          pending.delete(id);
          await runRetro(id);
          return;
        case "skip":
          pending.delete(id);
          await rpc.skip({ sessionID: id }).catch(fail("Skip"));
          return;
        case "later":
          pending.delete(id);
          toasted.delete(id);
          await rpc.later({ sessionID: id }).catch(fail("Later"));
          return;
        case "always":
          pending.delete(id);
          await setPolicy("always").catch(fail("Policy"));
          await runRetro(id);
          return;
        case "never":
          pending.delete(id);
          await setPolicy("never").catch(fail("Policy"));
          await rpc.skip({ sessionID: id }).catch(fail("Skip"));
          return;
      }
    }

    cleanups.push(
      rpc.events.on("due", (event) => {
        const due = event.data as unknown as DueEvent;
        pending.set(due.sessionID, due);
        drain();
      }),
    );

    for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.viewed"] as const) {
      cleanups.push(context.data.on(type, () => drain()));
    }

    cleanups.push(
      context.data.on("session.execution.started", (event) => {
        const id = event.data.sessionID;
        if (askTimer !== undefined) {
          clearTimeout(askTimer);
          askTimer = undefined;
        }
        if (askOpenFor === id) {
          // Turn started while the dialog is open: close it and treat as Later.
          const due = pending.get(id);
          pending.delete(id);
          toasted.delete(id);
          context.ui.dialog.clear();
          if (due) void rpc.later({ sessionID: id }).catch(fail("Later"));
        }
      }),
    );

    void rpc
      .pending({})
      .then((raw) => {
        const result = raw as { sessions: PendingSession[] };
        for (const s of result.sessions) {
          pending.set(s.sessionID, { sessionID: s.sessionID, title: s.title, projectDir: s.projectDir, turns: s.turns, idleMinutes: 0 });
        }
        drain();
      })
      .catch(() => {
        /* server half not loaded yet; due events will arrive later */
      });

    return () => {
      if (askTimer !== undefined) clearTimeout(askTimer);
      for (const c of cleanups) c();
    };
  },
});
