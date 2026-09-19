# DSH Desktop

English | [中文](README.zh.md)

## Summary

DSH Desktop packages the shared React/Cordis GUI for Windows x64, macOS x64/arm64, and Linux x64. A sandboxed Renderer loads local `file://` assets and connects by MessagePort to one Utility Process running `dsh --profile desktop`; no HTTP listener or browser cookie is involved. The app reuses the user’s `.dsh` directory for models, credentials, workspaces, and sessions. Installers are published by version to GitHub Releases; macOS ad-hoc builds require manual updates.

## Table of Contents

- [Run from a checkout](#run-from-a-checkout)
- [Build desktop artifacts](#build-desktop-artifacts)
- [Automatic releases](#automatic-releases)
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

<a id="build-desktop-artifacts"></a>
## Build desktop artifacts

Build on the target operating system and CPU; these commands package Windows x64:

```powershell
pnpm run build:official
pwsh -File native/vpn/scripts/build.ps1
pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime
pnpm --filter @deepseek-ai/dsh-desktop run stage:app
node apps/desktop/node_modules/electron-builder/out/cli/cli.js --projectDir .dsh-build/desktop-app --publish never --win nsis zip --x64
```

The build pins Electron 44.1.1, electron-builder 26.15.3, and pnpm 11.7.0. Outputs live under `apps/desktop/dist-electron`; staging projects use ignored `.dsh-build` directories. For macOS use `--mac dmg zip --arm64` or `--mac dmg zip --x64` in the final command. For Linux use `--linux AppImage deb --x64`, and run `pnpm --dir native/landlock-run run build:native` with musl-tools installed before runtime staging. Each target installs its own dependency closure; copied node_modules from another CPU or OS are unsupported.

Linux packages keep Chromium sandboxing enabled. The AppImage uses the repository’s [AppRun](assets/linux/AppRun), and final-container checks reject sandbox-disabling launch options. Ubuntu 24.04 GUI CI loads a temporary AppArmor user-namespace profile for the exact unpacked executable and removes it afterward; the user installation requirements live in the [Desktop guide](../../docs/user/guide/desktop.md).

Runtime staging requires the installed dependency cache. pnpm 11.7 also needs registry access when its lockfile policy cache cannot satisfy validation, even with `--offline`. It first verifies the unchanged workspace lock through a frozen offline pnpm install, then deploys those records offline with install scripts disabled. The deployment reuses that successful supply-chain verification because pnpm's generated lock changes local workspace paths; every registry package identity and complete integrity/URL resolution must equal the verified source, and any concurrent source-lock change rejects staging. Missing cache entries or failed verification stop packaging.

The installed runtime and pnpm omit type declarations, source maps, compiler state, debug symbols, and test/example/benchmark/GitHub workflow directories. Runtime modules, native binaries, package metadata, and licenses remain available as ordinary files for Node resolution and subprocess launches.

The native VPN distribution keeps its verified bytes, licenses, and corresponding-source archive under `resources/vpn`. The helper is selected for the target platform and CPU. macOS signs it ad-hoc before calculating its manifest, and Desktop signing excludes it from further changes. Packaging verifies the final helper bytes and native runtime permissions.

-----

<a id="automatic-releases"></a>
## Automatic releases

The [Desktop installer workflow](../../.github/workflows/desktop-publish.yml) compares the root version before and after a master push. Use `pnpm release:dsh <version>` to update the entire DSH family and commit its manifests and lockfile together. An unchanged version skips publication; a decrease or inconsistent package version fails. A manual run defaults to verification only; select `publish` to publish or retry the selected commit.

Four native builds produce Windows EXE/ZIP, macOS arm64 and x64 DMG/ZIP, and Linux x64 AppImage/DEB. Only successful builds enter the aggregate publisher. It verifies installer hashes and platform feeds, merges both macOS feed entries, uploads a draft with SHA256SUMS, verifies the uploaded bytes, and publishes `v<version>`. Pre-release versions retain GitHub’s prerelease flag; stable releases request GitHub’s `legacy` Latest selection, based on release creation date and semantic version. Published versions are immutable, and a tag pointing at another commit rejects the run.

Downloads and in-app feeds use [addy777-coder/deepseek-harness](https://github.com/addy777-coder/deepseek-harness/releases). Publishing uses the repository GITHUB_TOKEN with contents write permission only in the publishing job; npm and PyPI publication are separate.

-----

<a id="process-and-window-behavior"></a>
## Process and window behavior

One main window owns navigation, Sessions, and Settings. Session links and notification clicks select the Session in this window; navigation received before the Client subscribes waits for readiness. Closing the main window exits the application. The main process allows up to 120 seconds for cold profile initialization and Loader settlement; a readiness timeout reports the last startup phase and the Host stderr tail. On exit, it asks the Host to stop and waits up to five seconds before terminating its process tree. An unexpected Host exit leaves the window open on a diagnostic page until the user selects **Restart Host**.

Installed applications register `dsh://new` and `dsh://session/<base64url-session-id>` where their package format supports desktop integration. Windows/macOS support launch at sign-in when protocol registration is active; Linux exposes that preference as unavailable. A global shortcut and completion notifications work through the native desktop session; portable Windows ZIP builds do not register the protocol.

The Settings **About** page on Windows and supported Linux formats checks the GitHub Releases feed, downloads the full installer with progress, and installs after a native confirmation. macOS ad-hoc builds offer the releases page for manual installation. Cancellation closes the HTTP request and cached-file writer before another download starts; errors remain visible, and ordinary application exit never installs an update.

Feed configuration comes from the publish section of `electron-builder.yml` (`app-update.yml` in resources). An unpackaged build checks a generic feed only when `DSH_DESKTOP_UPDATE_FEED` is set; the Electron scenario uses that override against a local fixture server. The [updater decision](../../.agents/notes/implemented/feature/2026-09-09-desktop-in-app-update.md) explains the `builder-util-runtime@9.7.0` cancellation patch and full-installer policy.

Plugin candidates use private sibling directories of the live profile so pnpm’s relative local-package references survive the atomic rename. Cancellation and rejected candidates remove those directories.

POSIX shutdown captures descendants before requesting graceful exit, terminates only matching PID/start identities, and waits for detached command groups to stop before restarting the Host. Timeout errors identify surviving processes.

-----

<a id="test-the-application"></a>
## Test the application

```powershell
pnpm exec vitest run apps/desktop/tests packages/desktop/transport/tests
pnpm run test:desktop
```

The Electron test allocates private Harness home, user-data, update-cache, and workspace directories. It exercises IPC, a model-compatible mock round, platform shell execution, approval, attachments, windows, notifications, deep links, plugin replacement and rollback, and quiescent Host recovery. Windows also automates the native directory dialog; Windows/Linux exercise update cancellation and retry, while macOS verifies manual updates. Set `DSH_DESKTOP_EXECUTABLE` to the unpacked packaged executable. `DSH_DESKTOP_REPLAY=1` selects the committed platform shell session; the Windows snapshot adapter is part of `pnpm run test:snapshot`.

-----

<a id="security-notes"></a>
## Security notes

Renderer windows use context isolation, Chromium sandboxing, no Node integration, and Web security. The preload exposes fixed operations only; navigation and popups are denied, while HTTP(S) targets open through the system browser. The main process transfers ports and owns operating-system integration but does not read model request payloads or API keys. Client bundle execution currently requires CSP `unsafe-eval` because the Cordis Client Loader materializes plugin factories dynamically.

Plugin installation resolves one package spec with the bundled pnpm and `--ignore-scripts`. Any newly introduced or changed dependency that declares `preinstall`, `install`, `postinstall`, or `prepare` is rejected. An approved plugin still executes inside the Host with the current user's local permissions.

<a id="dev-note"></a>
## Dev Note

None.
