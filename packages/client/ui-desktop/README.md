---
description: "Desktop-only GUI presentation for DSH Desktop: integrated title bar, native notifications, preferences, and profile plugin management."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-desktop` adapts the shared GUI to Electron without replacing the conversation interface. It adds the DSH Desktop title bar and brand, keeps main-window navigation and connects session state to native notifications. The main window also receives global-shortcut, launch-at-sign-in, transactional plugin-management settings, and the About page that drives the in-app update lifecycle. The package requires the fixed preload API supplied by `apps/desktop` and fails outside that shell.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Desktop carrier bundle mounts both halves and supplies the Electron preload globals before the Client Loader starts.

### When to choose it

Choose this plugin only for windows loaded by DSH Desktop. A browser profile uses its ordinary branding and navigation plugins; mounting this package there fails because no trusted Desktop bootstrap or shell API exists.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-client-ui-desktop'
```

The plugin has no configuration fields. The main-process bootstrap supplies the installed application version.

### Window behavior

The main window retains the sidebar and Settings. The title bar creates a new task; Session links and notification clicks select their Session in this same window. The preload delivers navigation after the Client subscribes, including links received during startup or reload. Completion transitions request native notifications.

The About page keeps cancellation available while a download is pending and permits another download after cancellation completes. Update failures display the main process's diagnostic; preload request failures also appear on the page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half is empty and exists only as a Loader row. The Client half fills shared layout, sidebar-brand, General settings, Plugins settings, and About settings slots. It subscribes to the existing Session list rather than owning a second cache: selection changes update the main process, and a running-to-settled edge requests a notification. The preload bridge owns all operating-system mutations and exposes only fixed operations.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Slot registration, shell navigation intents, and notification transitions |
| [`src/client/TitleBar.tsx`](src/client/TitleBar.tsx) | Integrated caption content and new-task action |
| [`src/client/DesktopPreferences.tsx`](src/client/DesktopPreferences.tsx) | Shortcut and launch-at-sign-in settings |
| [`src/client/PluginManager.tsx`](src/client/PluginManager.tsx) | Resolve, review, apply, and cancel plugin transactions |
| [`src/client/AboutSection.tsx`](src/client/AboutSection.tsx) | Installed version, update check/download/install, and the releases link |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Simplified Chinese product copy |
| — | No runtime invariant companion is published; the plugin contributes UI slots and derives all state from existing Session and preload owners. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop user guide](../../../docs/user/guide/desktop.md) — window, shortcut, recovery, and plugin workflows.
- [Desktop carrier bundle](../../bundle/desktop-app/README.md) — Host and Client rows that activate this plugin.
- [UI layout](../ui-layout/README.md) — title-bar and panel slots.
- [Desktop transport](../../desktop/transport/README.md) — Renderer-to-Host delivery.
- [Desktop architecture decision](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.md) — main-process authority and security choices.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package presents Desktop controls and existing Session state without adding model context.

#### KV Cache effect

None; title bars, notifications, and settings do not change request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints keep the first Desktop surface aligned with the Windows shell.

- **Notification delivery depends on Windows settings** — the application suppresses a notice for a focused Session window but cannot override system notification policy.
- **Portable builds cannot enable launch at sign-in** — the setting is available only when the installed application owns the `dsh://` protocol registration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
