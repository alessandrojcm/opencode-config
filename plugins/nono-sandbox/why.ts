// `nono why --self` integration: typed wrapper around the CLI plus the pure helpers used by
// the `nono_why` tool and the permission pre-check hook in index.ts.

export type FsOp = "read" | "write" | "readwrite";

export type WhyQuery = { kind: "path"; path: string; op: FsOp } | { kind: "host"; host: string; port?: number };

export interface WhyResult {
  status: "allowed" | "denied" | string;
  reason?: string;
  details?: string;
  access?: string;
  policy_source?: string;
}

export function whyArgs(query: WhyQuery): string[] {
  const base = ["why", "--self", "--json"];
  if (query.kind === "path") return [...base, "--path", query.path, "--op", query.op];
  return [...base, "--host", query.host, ...(query.port ? ["--port", String(query.port)] : [])];
}

export function parseWhy(stdout: string): WhyResult | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as WhyResult).status === "string") return parsed as WhyResult;
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Runs `nono why --self --json ...`. Returns null when nono is missing, times out, or prints
 * something we cannot parse; callers must fail open — the kernel sandbox still enforces.
 */
export async function runWhy(query: WhyQuery, timeoutMs = 3000): Promise<WhyResult | null> {
  const bin = Bun.which("nono");
  if (!bin) return null;
  try {
    const proc = Bun.spawn([bin, "-s", ...whyArgs(query)], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return parseWhy(stdout);
  } catch {
    return null;
  }
}

/** Maps an OpenCode permission action to the nono filesystem op it needs, or null if not a path action. */
export function opForAction(action: string): FsOp | null {
  switch (action) {
    case "read":
    case "external_directory":
      return "read";
    case "edit":
      return "write";
    default:
      return null;
  }
}

/**
 * Turns a permission resource into an absolute path to ask nono about. Returns null for
 * resources inside `location` (the sandbox always grants the worktree) and for non-path shapes.
 */
export function resourceToPath(resource: string, location: string, home = Bun.env.HOME ?? ""): string | null {
  let p = resource.trim();
  if (!p || p === "*") return null;
  if (p.endsWith("/*")) p = p.slice(0, -2);
  if (p.startsWith("~/") && home) p = home + p.slice(1);
  else if (p === "~" && home) p = home;
  if (/[*?]/.test(p)) return null;
  if (!p.startsWith("/")) p = `${location.replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
  p = p.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const root = location.replace(/\/+$/, "");
  if (p === root || p.startsWith(root + "/")) return null;
  return p;
}

export function buildDenyMessage(path: string, op: FsOp, why: WhyResult, profileDraftsDir: string): string {
  const reason = [why.reason, why.details].filter(Boolean).join(": ");
  return [
    `[nono sandbox] ${op} access to ${path} is denied by the nono sandbox${reason ? ` (${reason})` : ""}.`,
    "This is kernel-enforced (Landlock/Seatbelt): sudo, chmod, retries or alternate paths cannot bypass it.",
    "Either work inside the granted paths, or ask the user to:",
    `  Option A (one-off): restart the sandbox with \`nono run --allow ${path} ... -- opencode\``,
    `  Option B (persistent): draft ${profileDraftsDir}/<name>.json extending the active profile, add the path under "allow" or "read", then run \`nono profile promote <name>\``,
  ].join("\n");
}
