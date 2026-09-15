// nono sandbox awareness for OpenCode V2.
//
// Migrated from the V1 plugin shipped by the `nolabs-ai/opencode` nono pack
// (~/.config/nono/packages/nolabs-ai/opencode/plugin/nono-sandbox.ts), which OpenCode 2.x
// rejects because it has no default `Plugin.define` export. Behaviour is unchanged:
// - no-op unless the server process runs inside nono (`NONO_CAP_FILE` set),
// - inject sandbox context into the system prompt of every agent request,
// - register a `nono_status` tool that prints the capability set,
// - append remediation guidance to tool results that look like a sandbox denial.
// Additions over the pack plugin:
// - `nono_why` tool: typed `nono why --self --json` for a path+op or a host, so the model can
//   check access *before* attempting it instead of parsing EPERM afterwards,
// - permission pre-check: `permission.hook("evaluate")` asks nono about read/edit/
//   external_directory resources outside the worktree and turns a sandbox denial into a
//   `deny` with remediation text, so the doomed action never runs. Fails open on any error.
//
// Only the OpenCode *server* process's environment matters: a sandboxed `--standalone`
// worker sees NONO_CAP_FILE, a TUI attached to the shared host service does not.

import { Plugin } from "@opencode/plugin";
import { buildDenyMessage, opForAction, resourceToPath, runWhy, type FsOp } from "./why.ts";

const DENIAL_PATTERN = /operation not permitted|permission denied|eperm|eacces|sandbox.*denied|landlock/i;

const PATH_RE = /(?:~\/|\/)[^\s"'`,;:]+/;

type CredentialRoute = {
  upstream: string;
  credential_key: string;
  inject_header: string;
  env_var?: string;
};

export type Caps = {
  fs?: Array<{ path: string; resolved?: string; access: string }>;
  net_blocked?: boolean;
  allowed_domains?: string[];
  credentials?: Record<string, CredentialRoute>;
  session_id?: string;
};

function insideNono(): boolean {
  return Boolean(Bun.env.NONO_CAP_FILE);
}

async function readCaps(): Promise<Caps | null> {
  const capFile = Bun.env.NONO_CAP_FILE;
  if (!capFile) return null;
  try {
    return (await Bun.file(capFile).json()) as Caps;
  } catch {
    return null;
  }
}

export function extractPath(text: string): string | null {
  const match = PATH_RE.exec(text);
  if (!match) return null;
  let candidate = match[0].replace(/[).\]]+$/, "");
  if (candidate.startsWith("~/")) {
    candidate = (Bun.env.HOME ?? "~") + "/" + candidate.slice(2);
  }
  return candidate || null;
}

function expandHome(p: string): string {
  const home = Bun.env.HOME;
  if (!home) return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? home + p.slice(1) : p;
}

function nonoConfigHome(): string {
  return (Bun.env.XDG_CONFIG_HOME ?? `${Bun.env.HOME ?? "~"}/.config`) + "/nono";
}

function profileDraftsDir(): string {
  return nonoConfigHome() + "/profile-drafts";
}

function buildCredentialLines(caps: Caps): string {
  const routes = caps.credentials ?? {};
  const keys = Object.keys(routes);
  if (keys.length === 0) return "  (none enabled — add routes to network.credentials in your profile)";
  return keys
    .map((name) => {
      const r = routes[name];
      const envVar = r.env_var ?? r.credential_key;
      const present = Boolean(Bun.env[envVar]);
      return `  ${name}: ${r.upstream}  [${present ? "key present" : "key missing — set " + envVar}]`;
    })
    .join("\n");
}

function buildDomainLines(caps: Caps): string {
  const domains = caps.allowed_domains ?? [];
  if (domains.length === 0) {
    return caps.net_blocked ? "  (all outbound network blocked)" : "  (no allowlist — all outbound network allowed)";
  }
  return domains.map((d) => "  " + d).join("\n");
}

function buildEgressGuidance(caps: Caps): string {
  const domains = caps.allowed_domains ?? [];
  if (caps.net_blocked) {
    return "All outbound network is blocked. Retries, alternate endpoints, or proxies cannot bypass this — do not attempt workarounds.";
  }
  if (domains.length === 0) {
    return "No host allowlist is in effect; all outbound network is allowed.";
  }
  return [
    "Network egress is default-deny; only these hosts are reachable. Any other outbound connection fails by design — retries, alternate endpoints, or proxies cannot bypass it, so do not attempt workarounds:",
    buildDomainLines(caps),
  ].join("\n");
}

export function buildGuidance(caps: Caps, blockedPath: string | null): string {
  const pathLines =
    (caps.fs ?? []).map((e) => "  " + (e.resolved ?? e.path) + " (" + e.access + ")").join("\n") || "  (none)";
  const net = caps.net_blocked ? "blocked" : "allowed";
  const display = blockedPath ?? "<blocked-path>";
  const whyCmd = blockedPath
    ? `nono why --self --path ${blockedPath} --op read`
    : "nono why --self --path <blocked-path> --op read";
  const allowCmd = blockedPath ? `nono run --allow ${blockedPath} -- opencode` : "nono run --allow <blocked-path> -- opencode";

  return [
    "",
    "---",
    "**[nono sandbox]** This is a sandbox permission denial — not a Unix or macOS permissions issue.",
    "Do NOT suggest sudo, chmod, or system permission changes.",
    "",
    "Blocked path: " + display,
    "",
    "Allowed paths in this session:",
    pathLines,
    "Network: " + net,
    "",
    "Reachable hosts (allowlist):",
    buildDomainLines(caps),
    "",
    "Active credential routes:",
    buildCredentialLines(caps),
    "",
    "Next steps (in order):",
    "1. Run `" + whyCmd + "` and include output verbatim.",
    "2. Present the user with exactly these two options:",
    "   Option A (quick fix):  " + allowCmd,
    "   Option B (persistent): draft a profile to " + profileDraftsDir() + "/<name>.json",
    '                          extending `opencode`, add the path under `"allow"` or `"read"`,',
    "                          then tell the user: run `nono profile promote <name>`",
    "                          and start future sessions with `nono run --profile <name> -- opencode`",
  ].join("\n");
}

export function buildSystemContext(caps: Caps): string {
  const sessionId = caps.session_id ?? Bun.env.NONO_SESSION_ID;
  const reattachNote = sessionId ? `\nSession ID: ${sessionId}. To reattach after detaching: nono attach ${sessionId}` : "";

  return `
You are running inside nono, an OS-level security sandbox. nono enforces filesystem and network limits via Landlock (Linux) or Seatbelt (macOS) before opencode starts.

sudo, chmod, chown, retries, or macOS Full Disk Access cannot grant access that nono has not allowed.${reattachNote}

If a tool or shell command fails with "Operation not permitted", "Permission denied", EACCES, EPERM, landlock, or sandbox denied:
1. Run: nono why --self --path <blocked-path> --op <read|write|readwrite>
2. Offer the user exactly two options:
   Option A: nono run --allow /path/to/needed -- opencode
   Option B: draft ${profileDraftsDir()}/<name>.json extending "opencode", then have the user run nono profile promote <name>

Credential injection is active for configured routes. Do not read or write API keys directly — nono injects them transparently via its proxy.

${buildEgressGuidance(caps)}

Do not edit ${nonoConfigHome()}/profiles or ${nonoConfigHome()}/packages from inside the sandbox.
`.trim();
}

export function buildStatusReport(caps: Caps | null): string {
  if (!caps) return "Not running inside a nono session (NONO_CAP_FILE is not set).";

  const sessionId = caps.session_id ?? Bun.env.NONO_SESSION_ID;
  const net = caps.net_blocked ? "blocked" : "allowed";
  const fsPaths = (caps.fs ?? []).map((e) => "  " + (e.resolved ?? e.path) + " (" + e.access + ")").join("\n") || "  (none)";

  const lines = [
    "nono sandbox: active",
    sessionId ? "session: " + sessionId + "  (reattach: nono attach " + sessionId + ")" : "",
    "network: " + net,
    "reachable hosts:",
    buildDomainLines(caps),
    "filesystem:",
    fsPaths,
    "credential routes:",
    buildCredentialLines(caps),
  ];
  return lines.filter(Boolean).join("\n");
}

type ContentPart = { type: string; text?: string } & Record<string, unknown>;

interface ResultLike {
  output?: unknown;
  content?: string | ReadonlyArray<ContentPart>;
  metadata?: Record<string, unknown>;
}

/** Returns a copy of `result` with `guidance` appended to its last text content (or output). */
export function appendGuidance<T extends ResultLike>(result: T, guidance: string): T {
  if (typeof result.content === "string") {
    return { ...result, content: result.content + guidance };
  }
  if (Array.isArray(result.content)) {
    const parts: ContentPart[] = [...result.content];
    const lastText = parts.map((p) => typeof p.text === "string").lastIndexOf(true);
    if (lastText >= 0) {
      parts[lastText] = { ...parts[lastText], text: (parts[lastText].text as string) + guidance };
    } else {
      parts.push({ type: "text", text: guidance });
    }
    return { ...result, content: parts };
  }
  if (typeof result.output === "string") {
    return { ...result, output: result.output + guidance };
  }
  return { ...result, content: guidance.trimStart() };
}

/** Hooks must never throw: an unhandled hook error aborts every tool call in the session. */
function swallow<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error("[nono-sandbox] hook failed:", error);
    }
  };
}

export default Plugin.define({
  id: "nono-sandbox",
  async setup(ctx) {
    if (!insideNono()) return;

    const caps = await readCaps();

    if (caps) {
      await ctx.session.hook(
        "context",
        swallow((event) => {
          event.system.push({ type: "text", text: buildSystemContext(caps) });
        }),
      );
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "nono_status",
        description:
          "Show nono sandbox status for this opencode session: capability set, network egress allowlist, credential routes and session ID.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({
          content: buildStatusReport(await readCaps()),
          metadata: { title: "nono sandbox status" },
        }),
      });

      editor.add({
        name: "nono_why",
        description:
          "Ask the nono sandbox whether an access would be allowed BEFORE attempting it. Pass `path` + `op` for filesystem access, or `host` (+ optional `port`) for network egress. Returns nono's decision, reason and policy source. Use this when you need a path outside the worktree or an unusual host; a denial is kernel-enforced and cannot be worked around.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or ~/ path to check" },
            op: { type: "string", enum: ["read", "write", "readwrite"], description: "Filesystem operation (default read)" },
            host: { type: "string", description: "Hostname or URL to check for outbound network access" },
            port: { type: "integer", description: "Port for the host check (default 443)" },
          },
          additionalProperties: false,
        },
        execute: async (raw) => {
          const input = raw as { path?: string; op?: FsOp; host?: string; port?: number };
          if (!input.path && !input.host) return { content: "Provide either `path` (+ `op`) or `host`." };
          const query = input.path
            ? ({ kind: "path", path: expandHome(input.path), op: input.op ?? "read" } as const)
            : ({ kind: "host", host: input.host!, port: input.port } as const);
          const why = await runWhy(query);
          if (!why) return { content: "nono why did not answer (nono missing, timed out, or returned unparsable output). The sandbox still enforces; try the operation and read the error." };
          const target = query.kind === "path" ? `${query.op} ${query.path}` : `connect ${query.host}:${query.port ?? 443}`;
          const lines = [
            `${why.status.toUpperCase()}: ${target}`,
            why.reason && `reason: ${why.reason}`,
            why.details && `details: ${why.details}`,
            why.access && `access: ${why.access}`,
            why.policy_source && `policy source: ${why.policy_source}`,
          ].filter(Boolean) as string[];
          if (why.status === "denied") lines.push("", "Kernel-enforced: do not retry or work around. Ask the user for Option A (`nono run --allow ...`) or Option B (profile draft) if the access is truly required.");
          return { content: lines.join("\n"), metadata: { title: `nono why: ${why.status}` } };
        },
      });
    });

    // Permission pre-check: refuse out-of-worktree path actions nono would deny anyway.
    const location = ctx.location.directory;
    await ctx.permission.hook(
      "evaluate",
      swallow(async (event) => {
        if (event.effect === "deny") return;
        const op = opForAction(event.action);
        if (!op) return;
        for (const resource of event.resources) {
          const path = resourceToPath(resource, location);
          if (!path) continue;
          const why = await runWhy({ kind: "path", path, op });
          if (why?.status !== "denied") continue;
          event.effect = "deny";
          event.message = buildDenyMessage(path, op, why, profileDraftsDir());
          return;
        }
      }),
    );

    await ctx.tool.hook(
      "execute.after",
      swallow(async (event) => {
        if (event.status !== "completed") return;
        const resultText = JSON.stringify(event.result);
        if (!DENIAL_PATTERN.test(resultText)) return;

        const liveCaps = await readCaps();
        if (!liveCaps) return;

        const blockedPath = extractPath(JSON.stringify(event.input)) ?? extractPath(resultText);
        event.result = appendGuidance(event.result, buildGuidance(liveCaps, blockedPath));
      }),
    );
  },
});
