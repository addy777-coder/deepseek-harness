# Use DSH Desktop

English | [中文](desktop.zh.md)

DSH Desktop is the Windows x64, macOS Apple Silicon/Intel, and Linux x64 application for the same sessions, workspaces, models, and settings as the Web UI. It loads the GUI from local files and connects to its private Host process without opening a local HTTP port.

## Prerequisites

- Windows 10/11 x64, macOS on Apple Silicon or Intel, or Ubuntu 24.04 x64 with a desktop session
- A DeepSeek-compatible API endpoint and credential
- A workspace directory you want the agent to use

These packages have no publisher certificate. Windows SmartScreen can show an unknown-publisher warning. macOS uses ad-hoc signing without Apple notarization; if Gatekeeper blocks the downloaded app, allow that specific app through **System Settings → Privacy & Security**.

## Install or use the portable build

Choose a version and the file for your system and CPU from [GitHub Releases](https://github.com/addy777-coder/deepseek-harness/releases). Latest identifies the newest stable release; alpha, beta, and rc versions are marked Pre-release. Each release includes SHA256SUMS for checking downloads.

- Run `DSH-Desktop-<version>-win-x64.exe` for a current-user installation. The installer registers `dsh://` links and can later enable launch at sign-in.
- Extract `DSH-Desktop-<version>-win-x64.zip` for the portable build. It does not register `dsh://` and cannot enable launch at sign-in.

- On macOS, open `DSH-Desktop-<version>-mac-<arch>.dmg` and copy DSH Desktop into Applications; select `arm64` for Apple Silicon or `x64` for Intel. The matching ZIP contains the same app.
- On Linux, make `DSH-Desktop-<version>-linux-x64.AppImage` executable and launch it, or install the matching DEB with the system package manager. AppImage needs FUSE support and zenity or kdialog for directory selection; DEB declares zenity as a dependency. Desktop integration uses X11 or XWayland.

On Ubuntu 24.04, DEB installation configures the AppArmor permission needed by Chromium’s sandbox. AppImage requires an administrator to authorize user namespaces for its fixed installation path; without that permission it refuses to start. Use a fixed filename without a version, such as `dsh-desktop.AppImage`, so updates retain that path. Do not use `--no-sandbox` to bypass the requirement.

Removing the application retains the Harness home: `%USERPROFILE%\.dsh` on Windows and `~/.dsh` on macOS/Linux. It stores shared model settings, credentials, profiles, workspaces, and sessions.

## Start a task

Open DSH Desktop, acknowledge the testing notice, and choose a workspace. Open **Settings → Models** to save an API key if the shared Harness home does not already contain one. Enter a task in the composer exactly as you would in the Web UI.

The main window keeps workspace and Session navigation. Select a Session in the sidebar to switch tasks, or use **New task** in the title bar. **Session log** downloads the current Session, its descendants, and attachments as a ZIP. Closing the main window exits DSH Desktop.

## Desktop integration

Open **Settings → General → Desktop integration** to change or disable the default `Ctrl+Shift+Space` shortcut. The shortcut focuses the main window and opens the new-task view. A conflict is shown in Settings and does not prevent the application from running.

An installed Windows or macOS build with registered protocol handling can enable launch at sign-in; Linux does not offer that setting. The tray menu can show the main window, open a new task, or exit. A completion or failure notification appears only when no focused DSH Desktop window shows that Session; selecting the notification opens its Session in the main window.

Supported links are deliberately narrow:

```text
dsh://new
dsh://session/<base64url-session-id>
```

DSH Desktop rejects query strings, fragments, prompts, disk paths, and every other route.

## Update DSH Desktop

Windows and supported Linux packages update from the GitHub Releases feed. macOS packages require manual download and replacement from the releases page. Open **Settings → About & updates**, select **Check for updates**, then **Download update** and **Install and restart** after the download settles. Installation starts after a native confirmation, closes DSH Desktop, and reopens it with the new version.

A Windows portable ZIP build has no installation target of its own and instead installs the current-user application when the flow runs. The About page also opens the releases page for a manual download.

## Recover the Host

An unexpected Host exit leaves the window open and shows its diagnostic. Select **Restart Host** after reading the error. DSH Desktop starts a fresh Host and reloads every window; it does not replay a task automatically, so inspect the Session before deciding whether to continue.

When the application exits normally, it gives the Host up to five seconds to cancel work, flush state, and release subprocesses. It then terminates the remaining process tree if shutdown did not settle.

## Manage profile plugins

Open **Settings → Plugins → Manage**. Enter one pnpm package spec: a registry package, Git spec, URL, or absolute local path. Do not include pnpm flags; the entire field is one package argument.

DSH Desktop resolves the candidate in a temporary profile with pnpm 11.7.0 and does not execute install scripts. It rejects a new or changed dependency that declares `preinstall`, `install`, `postinstall`, or `prepare`. Review the resolved names, versions, integrity or commit, bundle patch, and Client bundle status before applying.

Applying requires a native confirmation because runtime plugin code has the same local permissions as the Host. The application stops the Host, replaces the complete profile, starts the candidate, and reloads all windows. If the candidate does not become ready, DSH Desktop restores the previous profile, restarts it, and reloads the windows. Cancelling, download failure, or validation failure leaves the live profile unchanged.

## Current limits

- Windows/Linux ARM64, Linux RPM packages, and remote Hosts are not included.
- No account login, publisher signing, Apple notarization, or plugin marketplace search.
- Plugins that require installation scripts cannot be installed in the first release.

## Continue

- [Configure models](./providers.md)
- [Use the Web UI](./index.md)
- [Develop and package a plugin](../develop/basic/publish.md)
- [Desktop application reference](../../../apps/desktop/README.md)
