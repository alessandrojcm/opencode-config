/** @jsxImportSource @opentui/solid */
import { SyntaxStyle, type RGBA, type ScrollBoxRenderable, type ThemeTokenStyle } from "@opentui/core";
import { Plugin } from "@opencode/plugin/tui";
import { onCleanup, Show } from "solid-js";
import { defaultRetroExportPath, resolveMarkdownExportPath, writeMarkdownExport } from "./report.ts";
import { homeDueLabel, parseRetroCommand, promptDueLabel } from "./remind.ts";
import { SessionRetro, type DueEvent, type PendingSession, type Policy } from "./rpc.ts";

type RunResult = { runID: string; ranAt: number; findings: number; report: string };
type SettingsResult = { projectDir: string; policy: Policy; idleMinutes: number; dbPath: string };

type Choice = "run" | "skip" | "later" | "always" | "never";
type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>;
type ReminderState = { bySession: Record<string, DueEvent> };
type ReportPageData = {
  title: string;
  report: string;
  sessionID?: string;
  exportPath?: string;
  returnRoute: Route;
};

const REPORT_ROUTE = "session-retro-report";

function DueStatus(props: { context: Plugin.Context; text: string | undefined }) {
  return (
    <Show when={props.text}>
      <box paddingLeft={1} flexShrink={0}>
        <text fg={props.context.theme.text.subdued}>{props.text}</text>
      </box>
    </Show>
  );
}

function syntaxRule(scope: string[], foreground: RGBA, style: Omit<ThemeTokenStyle["style"], "foreground"> = {}): ThemeTokenStyle {
  return { scope, style: { foreground, ...style } };
}

function reportSyntaxStyle(context: Plugin.Context): SyntaxStyle {
  const theme = context.theme;
  const syntax = theme.syntax;
  const markdown = theme.markdown;
  return SyntaxStyle.fromTheme([
    syntaxRule(["default"], theme.text.default),
    syntaxRule(["comment", "comment.documentation"], syntax.comment, { italic: true }),
    syntaxRule(["string", "symbol", "character"], syntax.string),
    syntaxRule(["number", "boolean", "constant", "float"], syntax.number),
    syntaxRule(["keyword", "keyword.return", "keyword.conditional"], syntax.keyword, { italic: true }),
    syntaxRule(["function", "function.call", "function.method"], syntax.function),
    syntaxRule(["variable", "property", "parameter", "field"], syntax.variable),
    syntaxRule(["type", "module", "class", "namespace"], syntax.type),
    syntaxRule(["operator", "keyword.operator"], syntax.operator),
    syntaxRule(["punctuation", "punctuation.bracket", "punctuation.delimiter"], syntax.punctuation),
    syntaxRule(["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4"], markdown.heading, { bold: true }),
    syntaxRule(["markup.heading.1"], markdown.heading, { bold: true, underline: true }),
    syntaxRule(["markup.bold", "markup.strong"], markdown.strong, { bold: true }),
    syntaxRule(["markup.italic"], markdown.emphasis, { italic: true }),
    syntaxRule(["markup.list"], markdown.listItem),
    syntaxRule(["markup.quote"], markdown.blockQuote, { italic: true }),
    syntaxRule(["markup.raw", "markup.raw.block"], markdown.code),
    syntaxRule(["markup.raw.inline"], markdown.code, { background: theme.background.default }),
    syntaxRule(["markup.link", "markup.link.url"], markdown.link, { underline: true }),
    syntaxRule(["markup.link.label"], markdown.linkText, { underline: true }),
  ]);
}

function ReportPage(props: { context: Plugin.Context; data?: ReportPageData }) {
  const theme = props.context.theme;
  const data = props.data;
  const syntaxStyle = reportSyntaxStyle(props.context);
  let scroll: ScrollBoxRenderable | undefined;

  onCleanup(() => syntaxStyle.destroy());

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
          <markdown
            width="100%"
            syntaxStyle={syntaxStyle}
            content={data?.report ?? "No retro report is available."}
            internalBlockMode="top-level"
            tableOptions={{ style: "grid", cellPaddingX: 1 }}
            conceal={true}
            fg={theme.markdown.text}
            bg={theme.background.default}
          />
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
    const [reminders, updateReminders] = context.storage.memory<ReminderState>("due", {
      initial: { bySession: {} },
    });
    const cleanups: Array<() => void> = [];

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Session retro", message, variant });

    const fail = (what: string) => (e: Error) => {
      toast(`${what} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    };

    function returnRoute(): Route {
      const route = context.ui.router.current();
      if (route.type === "plugin" && route.name === REPORT_ROUTE) {
        // SAFETY: this route is created only by showReport(), which supplies ReportPageData.
        const previous = (route.data as Partial<ReportPageData> | undefined)?.returnRoute;
        if (previous) return previous;
      }
      if (route.type === "home") return { type: "home" };
      if (route.type === "session") return { type: "session", sessionID: route.sessionID };
      return { ...route };
    }

    function showReport(title: string, report: string, sessionID: string | undefined, previous: Route, exportPath?: string) {
      context.ui.dialog.clear();
      context.ui.router.navigate({
        type: "plugin",
        name: REPORT_ROUTE,
        data: { title, report, sessionID, exportPath, returnRoute: previous } satisfies ReportPageData,
      });
    }

    function remember(due: DueEvent) {
      updateReminders((draft) => {
        draft.bySession[due.sessionID] = due;
      });
    }

    function forget(sessionID: string) {
      updateReminders((draft) => {
        delete draft.bySession[sessionID];
      });
    }

    function pendingIDs(): string[] {
      return Object.keys(reminders.bySession);
    }

    function replaceReminders(sessions: readonly PendingSession[]) {
      updateReminders((draft) => {
        draft.bySession = {};
        for (const session of sessions) {
          draft.bySession[session.sessionID] = {
            sessionID: session.sessionID,
            title: session.title,
            projectDir: session.projectDir,
            turns: session.turns,
            idleMinutes: 0,
          };
        }
      });
    }

    async function runRetro(id: string) {
      const previous = returnRoute();
      toast("Running retro…");
      await rpc
        .run({ sessionID: id })
        .then((raw) => {
          // SAFETY: SessionRetro validates the RPC output against its declared run schema.
          const r = raw as RunResult;
          toast(`Retro done: ${r.findings} finding${r.findings === 1 ? "" : "s"}.`, "success");
          showReport("Session retro", r.report, id, previous, defaultRetroExportPath(r.runID, r.ranAt));
        })
        .catch(fail("Retro"));
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current();
      if (route.type === "session") return route.sessionID;
      if (route.type === "plugin" && route.name === REPORT_ROUTE) {
        // SAFETY: this route is created only by showReport(), which supplies ReportPageData.
        return (route.data as Partial<ReportPageData> | undefined)?.sessionID;
      }
      return undefined;
    }

    async function dueFor(sessionID: string): Promise<DueEvent> {
      const existing = reminders.bySession[sessionID];
      if (existing) return existing;
      // SAFETY: SessionRetro validates the RPC output against its declared settings schema.
      const settings = (await rpc.settings({ sessionID })) as SettingsResult;
      return {
        sessionID,
        title: sessionID,
        projectDir: settings.projectDir,
        turns: 0,
        idleMinutes: settings.idleMinutes,
      };
    }

    async function runCommand(input?: string) {
      const command = parseRetroCommand(input);
      if (command.kind === "unknown") {
        toast(`Unknown /retro argument "${command.arg}". Use pending, settings, skip, later, always, or never.`, "warning");
        return;
      }
      if (command.kind === "pending") {
        const previous = returnRoute();
        // SAFETY: SessionRetro validates the RPC output against its declared pending schema.
        const raw = (await rpc.pending({})) as { sessions: PendingSession[] };
        replaceReminders(raw.sessions);
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
      if (command.kind === "settings") {
        const previous = returnRoute();
        // SAFETY: SessionRetro validates the RPC output against its declared settings schema.
        const settings = (await rpc.settings({ sessionID })) as SettingsResult;
        showReport(
          "Session retro settings",
          `Project: ${settings.projectDir}\nPolicy: ${settings.policy}\nIdle minutes: ${settings.idleMinutes}\nDatabase: ${settings.dbPath}`,
          sessionID,
          previous,
        );
        return;
      }
      await act(sessionID, await dueFor(sessionID), command.kind);
    }

    // Keymap layers are Solid-owned: register from a rendered slot rather than setup(),
    // which runs outside a component owner and silently leaves the command unreachable.
    cleanups.push(
      context.ui.router.register({
        name: REPORT_ROUTE,
        render: (input) => {
          // SAFETY: showReport is the sole producer of this named plugin route and always supplies ReportPageData.
          const data = input.data as ReportPageData | undefined;
          return <ReportPage context={context} data={data} />;
        },
      }),
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => {
            const sessionID = currentSessionID();
            return {
              mode: "global",
              commands: [
                {
                  id: "session-retro.run",
                  title: "Run session retro",
                  description: "Analyze this session, or use pending/settings/skip/later.",
                  group: "Session retro",
                  palette: true,
                  suggested: Boolean(sessionID && reminders.bySession[sessionID]),
                  slash: { name: "retro", arguments: true },
                  run: (input) => runCommand(input).catch(fail("Retro command")),
                },
              ],
            };
          });
          return null;
        },
      }),
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => <DueStatus context={context} text={promptDueLabel(input.sessionID, pendingIDs())} />,
      }),
      context.ui.slot({
        append: "home.footer.status",
        render: () => <DueStatus context={context} text={homeDueLabel(pendingIDs().length)} />,
      }),
    );

    async function act(id: string, due: DueEvent, choice: Choice) {
      const setPolicy = (policy: Policy) => rpc.policy({ projectDir: due.projectDir, policy });
      switch (choice) {
        case "run":
          forget(id);
          await runRetro(id);
          return;
        case "skip":
          await rpc
            .skip({ sessionID: id })
            .then(() => {
              forget(id);
              toast("Skipped this retro.");
            })
            .catch(fail("Skip"));
          return;
        case "later":
          await rpc
            .later({ sessionID: id })
            .then(() => {
              forget(id);
              toast("Snoozed until the next idle period.");
            })
            .catch(fail("Later"));
          return;
        case "always":
          forget(id);
          await setPolicy("always").catch(fail("Policy"));
          await runRetro(id);
          return;
        case "never":
          await setPolicy("never").catch(fail("Policy"));
          await rpc
            .skip({ sessionID: id })
            .then(() => forget(id))
            .catch(fail("Skip"));
          return;
      }
    }

    cleanups.push(
      rpc.events.on("due", (event) => {
        // SAFETY: SessionRetro validates due event data against its declared event schema.
        remember(event.data as DueEvent);
      }),
    );

    void rpc
      .pending({})
      .then((raw) => {
        // SAFETY: SessionRetro validates the RPC output against its declared pending schema.
        // Merge, don't replace: a due event can arrive after this snapshot was taken.
        for (const session of (raw as { sessions: PendingSession[] }).sessions) {
          remember({
            sessionID: session.sessionID,
            title: session.title,
            projectDir: session.projectDir,
            turns: session.turns,
            idleMinutes: 0,
          });
        }
      })
      .catch(() => {
        /* server half not loaded yet; due events will arrive later */
      });

    return () => {
      for (const c of cleanups) c();
    };
  },
});
