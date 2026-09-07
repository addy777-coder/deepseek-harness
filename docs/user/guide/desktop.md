# Use DSH Desktop on Windows

English | [中文](desktop.zh.md)

DSH Desktop is the Windows x64 application for the same sessions, workspaces, models, and settings as the Web UI. It loads the GUI from local files and connects to its private Host process without opening a local HTTP port.

## Prerequisites

- Windows 10 or Windows 11 on x64
- A DeepSeek-compatible API endpoint and credential
- A workspace directory you want the agent to use

The first release is unsigned. Windows SmartScreen can show an unknown-publisher warning for internal installation artifacts.

## Install or use the portable build

Use one of the two release artifacts:

- Run `DSH-Desktop-<version>-win-x64.exe` for a current-user installation. The installer registers `dsh://` links and can later enable launch at sign-in.
- Extract `DSH-Desktop-<version>-win-x64.zip` for the portable build. It does not register `dsh://` and cannot enable launch at sign-in.

Both variants leave `%USERPROFILE%\.dsh` in place when the application is removed. That directory holds your shared model settings, credentials, profiles, workspaces, and sessions.

## Start a task

Open DSH Desktop, acknowledge the testing notice, and choose a workspace. Open **Settings → Models** to save an API key if the shared Harness home does not already contain one. Enter a task in the composer exactly as you would in the Web UI.

The main window keeps workspace and Session navigation. Select **Open current session in a new window** to create a focused task window without the sidebar or Settings. The same Session reuses its existing task window; closing that window does not stop work. Closing the main window exits DSH Desktop and all task windows.

## Desktop integration

Open **Settings → General → Desktop integration** to change or disable the default `Ctrl+Shift+Space` shortcut. The shortcut focuses the main window and opens the new-task view. A conflict is shown in Settings and does not prevent the application from running.

An installed build can enable launch after Windows sign-in. The tray menu can show the main window, open a new task, or exit. A completion or failure notification appears only when no focused DSH Desktop window shows that Session; selecting the notification opens its task window.

Supported links are deliberately narrow:

```text
dsh://new
dsh://session/<base64url-session-id>
```

DSH Desktop rejects query strings, fragments, prompts, disk paths, and every other route.

## Recover the Host

An unexpected Host exit leaves the window open and shows its diagnostic. Select **Restart Host** after reading the error. DSH Desktop starts a fresh Host and reloads every window; it does not replay a task automatically, so inspect the Session before deciding whether to continue.

When the application exits normally, it gives the Host up to five seconds to cancel work, flush state, and release subprocesses. It then terminates the remaining process tree if shutdown did not settle.

## Manage profile plugins

Open **Settings → Plugins → Manage**. Enter one pnpm package spec: a registry package, Git spec, URL, or absolute local path. Do not include pnpm flags; the entire field is one package argument.

DSH Desktop resolves the candidate in a temporary profile with pnpm 11.7.0 and does not execute install scripts. It rejects a new or changed dependency that declares `preinstall`, `install`, `postinstall`, or `prepare`. Review the resolved names, versions, integrity or commit, bundle patch, and Client bundle status before applying.

Applying requires a native confirmation because runtime plugin code has the same local permissions as the Host. The application stops the Host, replaces the complete profile, starts the candidate, and reloads all windows. If the candidate does not become ready, DSH Desktop restores the previous profile, restarts it, and reloads the windows. Cancelling, download failure, or validation failure leaves the live profile unchanged.

## Current limits

- Windows x64 only; macOS, Linux, and remote Hosts are not included.
- No account login, code signing, automatic update, or plugin marketplace search.
- Plugins that require installation scripts cannot be installed in the first release.
- Task windows are not restored after an application restart.

## Continue

- [Configure models](./providers.md)
- [Use the Web UI](./index.md)
- [Develop and package a plugin](../develop/basic/publish.md)
- [Desktop application reference](../../../apps/desktop/README.md)
