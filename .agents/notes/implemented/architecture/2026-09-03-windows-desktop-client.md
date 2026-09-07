# Agent Note: Windows Desktop client with a private Host transport

Status: implemented

English | [中文](2026-09-03-windows-desktop-client.zh.md)

## Problem

The interactive GUI originally assumed an HTTP server, browser navigation, cookies, and one browser window. A Windows desktop application needs native windows, tray and protocol integration, focused Session windows, notifications, and local plugin management without giving a Renderer Node authority or exposing a loopback port. Rewriting the conversation UI would split product behavior, while placing the Host in Electron's main process would put model requests and credentials beside operating-system integration.

## Decision

DSH Desktop is a Windows x64 Electron application under `apps/desktop`. Electron 44.1.1 supplies Node 24.19, electron-builder 26.15.3 produces a current-user NSIS installer and portable zip, and the packaged application carries pnpm 11.7.0 for profile plugin transactions. The application uses the independent DSH Desktop name and letter mark.

The [packaging filters](../../../../apps/desktop/electron-builder.yml) exclude type declarations, source maps, compiler state, debug symbols, and test/example/benchmark/GitHub workflow directories from the runtime closure and pnpm. Runtime JavaScript, native dependencies, package metadata, and licenses remain ordinary files. This reduces per-file extraction and deletion work in the Windows installer without moving subprocess executables or profile dependency targets into an archive.

### Shared GUI and carrier layers

The interactive profile composition has three ordered layers. `dsh-base` owns the agent core, `dsh-gui-app` owns the shared Host controllers and complete Client roster, and one carrier bundle owns physical delivery. The `web` profile selects `dsh-web-app`; the `desktop` profile selects `dsh-desktop-app`. Connection owns transport-neutral RPC, exact Fetch routes, and logical channels. Client Modules owns `ClientBootRegistry`, the module graph, and immutable bundle artifacts; the Web adapter renders them into HTML and `/plugins`, while Desktop returns them through IPC.

The Desktop profile uses `patchReload: startup`. A Desktop plugin change restarts the Host, so a live HMR watcher would add an incompatible second replacement lifecycle and require Node loader internals inside the packaged Utility Process.

### Process and security ownership

The Electron main process owns windows, the tray, shortcuts, protocol routing, notifications, native confirmation, and Host lifecycle. It starts exactly one Utility Process through the real `dsh --profile desktop` CLI path. Each sandboxed Renderer uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and `webSecurity: true`; its preload exposes fixed Desktop operations and transfers one dedicated MessagePort. The main process does not proxy or inspect model requests, attachment bodies, or API keys.

The version-1 Desktop protocol validates exact frame fields and bounded branded request/window ids. It carries boot injection tables, Connection Fetch requests and responses, module artifacts, pull-driven API Gateway streams, abort, attach, and shutdown. One `stream-pull` advances at most one item, and disposal aborts work and awaits iterator cleanup. Electron MessagePortMain accepts MessagePorts, but not ArrayBuffers, in its transfer list; binary bodies therefore use structured cloning in both directions rather than claiming zero-copy delivery.

Renderer navigation and popup creation are denied. HTTP and HTTPS targets open in the system browser. The Client Loader still requires CSP `unsafe-eval` to materialize dynamically delivered Cordis plugin factories; no network connection is permitted by the Desktop page policy.

### Windows lifecycle

One main window retains navigation and Settings. A Session owns at most one focused task window, which hides the sidebar and Settings; closing it leaves the Host task running. Host startup has a 120-second readiness budget that includes cold profile reconciliation and Loader settlement; timeout diagnostics name the last reported phase and include the bounded Host stderr tail. Closing the main window or selecting tray Exit destroys every window, asks the Host to stop, waits up to five seconds, and then terminates the remaining process tree. An unexpected Host exit keeps windows open on a diagnostic page until the user requests a restart; work is never replayed automatically.

The main window restores visible bounds and the shared Client selection. Task windows do not persist. `dsh://new` and `dsh://session/<base64url-session-id>` accept no query, fragment, prompt, or path data. The installed build can own protocol and launch-at-sign-in registration; the portable build cannot. Completion notifications are suppressed while any focused window shows the affected Session.

Electron Utility Processes report `electron.exe` as `process.execPath`. Internal Windows ACL and native-dialog Node helpers therefore receive `ELECTRON_RUN_AS_NODE=1` only in their runner environment. The ACL runner removes it before starting the user's command, so Electron's Node mode never leaks into the agent shell environment.

### Profile plugin transactions

The Plugins settings page accepts one pnpm package spec and passes it after `--`; it does not accept package-manager flags. Resolution occurs in a private temporary profile with `--ignore-scripts`. The manager compares the old and candidate dependency closures and rejects every new or changed package that declares `preinstall`, `install`, `postinstall`, or `prepare`. It validates bundle patch paths and the Client declarations and built exports referenced by inserted rows, then shows resolved versions, integrity or commit, and validation status.

Application requires a native warning because runtime plugin code has the Host's local permissions. The manager fingerprints profile-owned files, stops the Host, renames the old and candidate profile directories on the same volume, and starts the candidate. A readiness failure restores the backup, restarts the previous Host, and reloads all windows. Cancellation, resolution failure, script rejection, stale transaction detection, and validation failure leave the live profile unchanged. CLI and Desktop use the same pure bundle reconciliation function.

### Verification

Unit coverage owns frame validation, correlation, abort, stream backpressure, deep links, bounds, shortcut conflicts, plugin script rejection, Client-row validation, stale transactions, profile replacement, and rollback. The real Electron scenario uses private Harness home, user-data, and workspace roots; it proves no Host TCP listener, unary and streaming IPC, model and PowerShell tool rounds, approval, image attachment, main/task synchronization, notification suppression and click routing, second-instance deep-link deduplication, real local plugin installation, failed-start rollback, manual Host recovery, and quiescent exit. A Windows snapshot adapter replays a committed PowerShell session through the same Electron and MessagePort path. Pull-request Windows CI builds the packaged layout, runs that Electron scenario, and loads node-pty, Koffi, and Sharp under Electron's Node ABI; the trusted real-API workflow runs its short live DeepSeek mode.

## Alternatives considered

**Ship complete npm package contents.** Declarations and debug artifacts help development but add thousands of filesystem operations to installation and upgrades. The Desktop installer carries the runtime subset; the source workspace and package staging tree retain the development files.

**Loopback HTTP for Desktop.** This would reuse Web routing directly, but it would retain port allocation, Host/Origin and cookie state, and a network-reachable attack surface that an owned local window does not need.

**Run the Host in Electron's main process.** This removes one process, but it makes the operating-system authority read model payloads and credentials and lets Host failure take down every window without a diagnostic shell.

**Build a separate Desktop conversation UI.** This can optimize for one shell, but it duplicates the Session, approval, attachment, terminal, settings, and plugin ecosystems and lets Web and Desktop behavior drift.

**Keep live patch HMR.** Live HMR is useful for the browser development server, but Desktop plugin replacement already requires a Host restart and atomic profile transaction. Running both lifecycles complicates packaged Node-loader requirements and rollback.

**Allow dependency installation scripts.** This admits more npm packages, but a preview cannot safely explain or undo arbitrary script side effects. The first release rejects those closures before approval.

## Consequences

The application shares user data and GUI behavior with Web while keeping its Renderer sandboxed and its main process out of model traffic. Carrier-neutral registries make future local carriers possible without another API or UI fork. The costs are a large Windows-only Electron artifact, startup-only Desktop patches, structured-cloned binary bodies, a dynamic-loader CSP exception, and rejection of plugins that depend on install scripts. Code signing, automatic updates, remote Hosts, account login, and non-Windows packages remain outside the first release.
