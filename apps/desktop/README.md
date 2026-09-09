# DSH Desktop

English | [中文](README.zh.md)

## Summary

DSH Desktop packages the shared React/Cordis GUI as a Windows x64 Electron application. A sandboxed Renderer loads local `file://` assets and connects by MessagePort to one Utility Process running `dsh --profile desktop`; no HTTP listener or browser cookie is involved. The app reuses `%USERPROFILE%\.dsh` for models, credentials, workspaces, and sessions. The first release is unsigned and does not include automatic updates.

## Table of Contents

- [Run from a checkout](#run-from-a-checkout)
- [Build Windows artifacts](#build-windows-artifacts)
- [Process and window behavior](#process-and-window-behavior)
- [Test the application](#test-the-application)
- [Security notes](#security-notes)
- [Dev Note](#dev-note)

-----

<a id="run-from-a-checkout"></a>
## Run from a checkout

Build the Host and Client packages, stage the installed runtime closure, build the Electron assets, and start the app:

```powershell
pnpm run build:lib:host
pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop start
```

The source application still launches the Host through the `dsh` entry. Set `DSH_DESKTOP_RUNTIME_DIR` to `.dsh-build\desktop-runtime` when testing the staged installed closure; omit it to use the source CLI bootstrap.

-----

<a id="build-windows-artifacts"></a>
## Build Windows artifacts

Run the repository-owned packaging command on Windows x64:

```powershell
pnpm run package:desktop:win
```

The build pins Electron 44.1.1, electron-builder 26.15.3, and pnpm 11.7.0. It writes a current-user NSIS installer and portable zip under `apps\desktop\dist-electron`. The staging projects live under ignored `.dsh-build` directories so electron-builder does not interpret the repository workspace as the packaged application.

Runtime staging requires the installed dependency cache. It first verifies the unchanged workspace lock through a frozen offline pnpm install, then deploys those records offline with install scripts disabled. The deployment reuses that successful supply-chain verification because pnpm's generated lock changes local workspace paths; every registry package identity and complete integrity/URL resolution must equal the verified source, and any concurrent source-lock change rejects staging. Missing cache entries or failed verification stop packaging.

The installed runtime and pnpm omit type declarations, source maps, compiler state, debug symbols, and test/example/benchmark/GitHub workflow directories. Runtime modules, native binaries, package metadata, and licenses remain available as ordinary files for Node resolution and subprocess launches.

The native VPN distribution retains its independently verified bytes, licenses and corresponding-source archive under `resources/vpn`. Desktop code signing excludes `dsh-vpn.exe` so its manifest digest remains valid; the application and installer keep their normal signing policy.

-----

<a id="process-and-window-behavior"></a>
## Process and window behavior

One main window owns navigation and Settings. A Session can open in one deduplicated focused task window; closing that window does not stop its task, while closing the main window exits the application. The main process allows up to 120 seconds for cold profile initialization and Loader settlement; a readiness timeout reports the last startup phase and the Host stderr tail. On exit, it asks the Host to stop and waits up to five seconds before terminating its process tree. An unexpected Host exit leaves the windows open on a diagnostic page until the user selects **Restart Host**.

The installed application registers `dsh://new` and `dsh://session/<base64url-session-id>`, supports an optional global shortcut and launch at sign-in, and publishes completion notifications only when no focused window shows that Session. Portable builds do not register the protocol or enable launch at sign-in.

-----

<a id="test-the-application"></a>
## Test the application

```powershell
pnpm exec vitest run apps/desktop/tests packages/desktop/transport/tests
pnpm run test:desktop
```

The Electron test allocates private Harness home, user-data, and workspace directories. It exercises native Unicode directory selection and cancellation, unary and streaming IPC, a real model-compatible mock round, PowerShell execution, approval, image attachment, task windows, notifications, deep links, plugin replacement and rollback, manual Host recovery, and quiescent exit. Set `DSH_DESKTOP_EXECUTABLE` to an unpacked packaged executable to run the same scenario against installation assets. The recorded-session adapter runs through `pnpm run test:snapshot` on a built Windows checkout.

-----

<a id="security-notes"></a>
## Security notes

Renderer windows use context isolation, Chromium sandboxing, no Node integration, and Web security. The preload exposes fixed operations only; navigation and popups are denied, while HTTP(S) targets open through the system browser. The main process transfers ports and owns operating-system integration but does not read model request payloads or API keys. Client bundle execution currently requires CSP `unsafe-eval` because the Cordis Client Loader materializes plugin factories dynamically.

Plugin installation resolves one package spec with the bundled pnpm and `--ignore-scripts`. Any newly introduced or changed dependency that declares `preinstall`, `install`, `postinstall`, or `prepare` is rejected. An approved plugin still executes inside the Host with the current user's local permissions.

<a id="dev-note"></a>
## Dev Note

None.
