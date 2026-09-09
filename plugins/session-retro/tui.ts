import { Plugin } from "@opencode-ai/plugin/tui";
import { SessionRetro, type DueEvent, type PendingSession, type Policy } from "./rpc.ts";

type RunResult = { runID: string; findings: number; report: string };
type SettingsResult = { projectDir: string; policy: Policy; idleMinutes: number; dbPath: string };

type Choice = "run" | "skip" | "later" | "always" | "never";

const ASK_GRACE_MS = 2_000;

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
      toast("Running retro…");
      await rpc
        .run({ sessionID: id })
        .then(async (raw) => {
          const r = raw as RunResult;
          toast(`Retro done: ${r.findings} finding${r.findings === 1 ? "" : "s"}.`, "success");
          await context.ui.dialog.alert({ title: "Session retro", message: r.report });
        })
        .catch(fail("Retro"));
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    }

    async function runCommand(input?: string) {
      const arg = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (arg === "pending") {
        const raw = (await rpc.pending({})) as { sessions: PendingSession[] };
        const message = raw.sessions.length
          ? raw.sessions.map((s) => `• ${s.title} (${s.sessionID})\n  ${s.turns} turns · ${s.projectDir}`).join("\n\n")
          : "No sessions with a pending retro.";
        await context.ui.dialog.alert({ title: "Pending retros", message });
        return;
      }

      const sessionID = currentSessionID();
      if (!sessionID) {
        toast("Open a session before running /retro.", "warning");
        return;
      }
      if (arg === "settings") {
        const settings = (await rpc.settings({ sessionID })) as SettingsResult;
        await context.ui.dialog.alert({
          title: "Session retro settings",
          message: `Project: ${settings.projectDir}\nPolicy: ${settings.policy}\nIdle minutes: ${settings.idleMinutes}\nDatabase: ${settings.dbPath}`,
        });
        return;
      }
      await runRetro(sessionID);
    }

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
