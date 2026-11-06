# OpenCode V2 web UI extensibility

Date: 2026-10-04. Target: locally installed `opencode v2.0.22`.

## Answer

**There is no documented, supported web UI plugin API in the V2 sources checked.** Plugins can extend server behavior, and CLI plugins can extend the terminal UI, but those terminal hooks are not browser components. For custom web panels, layouts, or workflows, plan on a separate frontend or a frontend fork—not a stock web UI plugin. This is an evidence-based support-boundary conclusion, not proof that every internal or future extension mechanism is absent. [1][2][3]

**Recommendation:** keep OpenCode as the backend and build a focused web frontend using `@opencode/client`. Add server-plugin RPC only for functionality the normal API does not expose. You do not need to recreate the agent runtime. A full replacement UI is only necessary if the desired changes span the whole application; a companion dashboard could be sufficient. The client and RPC are documented integration contracts; this recommendation is a design judgment. [4][5]

## Extension surfaces

| Surface | Supported customization | Evidence |
| --- | --- | --- |
| Server plugin | Tools, commands, domain transforms, hooks, storage, custom RPC | Plugin overview and RPC guide [1][5] |
| CLI/TUI plugin | Terminal commands, routes, slots, Markdown renderers, dialogs and other terminal UI facilities | CLI plugin guide [2] |
| Stock browser UI | No documented web component/slot/route registration contract found | V2 docs index and published plugin host entrypoints [3][6] |

The plugin overview explicitly says: “To change the terminal UI, build a CLI plugin.” The CLI guide describes its UI extensions as terminal extensions, not browser extensions. Do not assume a TUI plugin can load in the web app. [1][2]

The published `@opencode/plugin@2.0.22` host declaration lists only these plugin entrypoints: [3]

```ts
export interface Entrypoints {
  readonly server?: string;
  readonly tui?: string;
  readonly rpc?: string;
}
```

This supports the distinction between server, terminal and shared RPC contracts; it does not independently prove the absence of every possible internal web extension.

Backend customization and frontend rendering are separate. Registering a tool or command changes backend capabilities; it does not supply a custom browser panel. The stock UI's handling of any particular plugin-added capability would need to be checked separately. [1][2][3]

## Options

### 1. Separate frontend or companion UI — recommended starting point

Use `@opencode/client` to connect to the existing OpenCode server. Its main entrypoints are explicitly browser-compatible, with typed methods generated from the HTTP API contract. The guide demonstrates session creation, prompting, event subscriptions and plugin RPC. [4]

For additional backend features, register RPC in a server plugin and consume its shared contract with `client.rpc(...)`. Any HTTP client can alternatively call `POST /api/rpc/{rpcID}/{method}` with `{ "input": ... }`. Importing an RPC definition in the frontend does not register its implementation; the server plugin must also be configured. [4][5]

Conceptual shape:

```text
Custom browser UI
  ├─ OpenCode HTTP/client API → sessions, prompts, events, etc.
  └─ Plugin RPC               → custom backend features
                  Existing OpenCode server
```

The web guide documents authentication and CORS for external web clients. The built-in web UI is served by the same server as the TUI and is password protected; pairing authenticates the browser using a session cookie. A separately hosted UI needs its own deliberate authentication integration and, when cross-origin, appropriate CORS settings. CORS alone is not authentication. No service settings were changed for this research. [7][4]

### 2. Fork the existing frontend — possible approach, source compatibility unresolved

This could preserve more of the stock interface when changes are small, but first locate frontend source compatible with V2.0.22. The public repository inspected could not be matched to that installed release: its package naming/version differs from the published V2 packages. Fork/build feasibility for this exact release therefore remains unverified. [8][9]

In the inspected public commit, the server loads a generated embedded web bundle, or proxies to `https://app.opencode.ai` when that bundle is unavailable/disabled. Disabling the embedded UI in that implementation does **not** point it at your custom frontend. This is contextual source evidence, not an exact description verified against the installed V2.0.22 binary. [8]

### 3. Stock web UI plus server plugins — only if no custom rendering is needed

If the goal is agent behavior, tools, commands or other backend changes, a server plugin may suffice. If the goal is custom tabs, panels, layouts or browser components, the documented terminal UI extension APIs do not provide that web capability. [1][2][3]

## Verification and limits

- Local version was checked with `opencode --version`: `opencode v2.0.22`. Local `package.json` contains `@opencode/plugin` `2.0.4`; no dependency changes were made.
- The parent independently re-fetched the plugin overview, web guide, client guide, published `2.0.22` host declaration and commit-pinned server UI source after the background research.
- Live documentation is not version-pinned. Published package evidence is pinned to `2.0.22`; public server source is pinned to commit `907b3bc518fa48e90e8ec24dd327d13eee71c36c` but is **not established as the source of V2.0.22**. [3][8][9]
- No browser/runtime prototype was performed. No repository-wide structural absence check was performed; the conclusion concerns the documented API and inspected published host contract.
- Client event subscriptions are live-only, with no replay or automatic reconnection. A custom UI must handle recovery and refresh state rather than assume durable event delivery. [4]
- Before choosing a fork, the smallest unresolved research step is locating the exact V2 frontend source/release. This does not block using the documented browser client and plugin RPC approach. [4][5]

## Primary sources

1. [V2 plugin overview](https://opencode.ai/v2/docs/build/plugins/)
2. [V2 CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli/)
3. [`@opencode/plugin@2.0.22` published host declaration](https://cdn.jsdelivr.net/npm/@opencode/plugin@2.0.22/dist/host.d.ts); [npm release metadata](https://registry.npmjs.org/@opencode%2Fplugin/2.0.22)
4. [V2 JavaScript client guide](https://opencode.ai/v2/docs/build/client/)
5. [V2 plugin RPC guide](https://opencode.ai/v2/docs/build/plugins/rpc/)
6. [V2 documentation index](https://opencode.ai/v2/llms.txt)
7. [V2 web UI guide](https://opencode.ai/v2/docs/cli/web/)
8. [Public server UI source, commit-pinned](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/server/shared/ui.ts)
9. [Public plugin package manifest, same commit](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/plugin/package.json)
