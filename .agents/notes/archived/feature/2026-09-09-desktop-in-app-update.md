# Agent Note: In-app update for DSH Desktop

Status: implemented
Archived: 2026-09-19

English | [中文](2026-09-09-desktop-in-app-update.zh.md)

## Problem

The first DSH Desktop release ships installer and zip artifacts without any update mechanism ([architecture note](../architecture/2026-09-03-windows-desktop-client.md)). Users must watch the releases page manually, download the next installer, and reinstall. The Desktop main process needs a first-class update flow inside Settings.

## Decision

Ship electron-updater 6.8.9 in the Desktop main process and add an **About** settings page that owns the update lifecycle. The page checks the feed, downloads the installer into the updater cache with a cancellable byte-level progress view, and installs after a native confirmation; the installed version and the feed's latest version/notes are displayed beside the flow.

The feed uses GitHub Releases in `addy777-coder/deepseek-harness`, declared in `electron-builder.yml` and materialized as `resources/app-update.yml` in packaged builds. The [native release decision](../architecture/2026-09-11-cross-platform-desktop-releases.md) owns version-triggered builds, complete artifact verification, immutable `v<version>` releases, and retries.

Two feed facts fixed the design:

- electron-updater's GitHub provider scans release tags through `semver.valid`. A `dsh-v*` tag is never semver-valid and would be skipped, so a release tagged `dsh-v0.1.2-alpha.5` can never be offered to the updater. The publisher therefore creates a separate `v<version>` release per version while the npm sequence keeps `dsh-v*` tags.
- The publisher retains platform channel metadata: `latest.yml`, `latest-mac.yml`, and `latest-linux.yml`. GitHub’s prerelease flag distinguishes prereleases; both macOS architectures share a verified merged file list.

The updater is deliberately invisible until the user opens Settings: no in-app prompt, no tray advertisement. Checks run only from the About page, so release traffic has no listener in normal operation.

## State machine and seams

`apps/desktop/src/main/updater.ts` owns a `DesktopUpdater` state machine (`idle`, `checking`, `available`, `up-to-date`, `downloading`, `downloaded`, `installing`, `error`, `unsupported`) with single-flight check/download, progress patches, a 30-second bound on one check, and transitions only at commit points. All electron-updater and Electron interaction sits behind a `DesktopUpdaterRuntime` seam; the production implementation is `updater-runtime.ts`, which also wires the dev-feed override: `DSH_DESKTOP_UPDATE_FEED` points an unpackaged build at a generic feed through a userData `dev-app-update.yml` (`forceDevUpdateConfig`, `updateConfigPath`). The e2e scenario uses that override against a local HTTP fixture serving `latest.yml` and the fake installer with matching sha512.

The renderer receives the state through fixed preload operations (`checkForUpdate`, `downloadUpdate`, `installUpdate`, `cancelUpdate`, `getUpdateState`, `openReleases`) plus one push channel; the About page renders it through the inject `hooks` compartment, and no state crosses the wire outside this snapshot.

Every download owns a fresh cancellation token. The [pinned `builder-util-runtime@9.7.0` patch](../../../../patches/builder-util-runtime@9.7.0.patch) aborts the active HTTP request, destroys the download pipeline, and waits for the request and file writer to close before cancellation settles. Promise rejection alone leaves the transfer and writer active; awaited cleanup prevents them from interfering with a retry. The download releases its token and progress listener when it settles, and a retry receives a new token.

The About page tracks cancellation requests independently of the pending download, so the download's lifetime does not disable cancellation. The main process reports update failures in the state snapshot, while the page also reports preload request rejections.

## Alternatives considered

- **A Web-UI About page** was considered first and rejected: the update belongs to the packaged Desktop build, and the Web UI has no installer authority.
- **`electron-builder --publish always`** would create the GitHub release itself, but its tag grammar (`v<version>` only) and its draft-by-default behavior leave tag-and-release metadata outside the repository's explicit publication flow; the workflow owns release creation, prerelease flags, and retries explicitly.
- **Differential downloads** require blockmaps that the release feed does not publish. Their Range requests also bypass the patched HTTP cancellation path. The runtime sets `disableDifferentialDownload = true` and downloads complete installers; enabling differential downloads requires published blockmaps and cancellation that closes stalled Range requests and file writers before retry.
- **Portable zip updates** install the current-user application rather than replacing the zip in place; the limitation is documented on the About page copy and in the user guide.

## Consequences

Windows and supported Linux distributions check and download inside Settings, then request installation after a native confirmation. macOS ad-hoc builds report manual updates immediately. The main process never auto-installs on quit. Installation waits for Electron’s shutdown event or an updater error, releases both listeners, and reports an error if neither arrives within 30 seconds.

The Windows Electron scenario exercises feed-error reporting and download cancellation/retry through the About page, with a private update cache and a server response held open until cancellation. The [HTTP regression](../../../../apps/desktop/tests/updater-http.spec.ts) verifies cleanup for cancellation before headers, during the body, and after redirects, plus connection loss and checksum failures. Component tests cover English and Chinese failures and cancellation while downloads remain pending. The runtime regression uses electron-updater's real cancellation token to verify a successful second download and listener cleanup.

- The first stable release must be published before a stable channel can resolve `/releases/latest`; until then stable checks report an explicit feed error.
- Unsigned installers still run with their unsigned policy; the About page cannot bypass SmartScreen.
- Desktop `v*` tags and npm `dsh-v*` tags have separate publication workflows.
