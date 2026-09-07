---
description: "Windows Desktop carrier layer over the shared GUI, adding Electron MessagePort IPC, native directory selection, and Desktop-only Client integration."
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-app

English | [中文](README.zh.md)

## Summary

`dsh-desktop-app` turns the shared GUI composition into the Host used by DSH Desktop on Windows. The shipped `desktop` profile places it after `dsh-base` and `dsh-gui-app`, then applies user patches once at startup. This layer adds the Electron MessagePort transport, both halves of native directory selection, and Desktop-only title bar, notification, preference, and plugin-management presentation. The Electron application, not this bundle, owns windows, system registration, process shutdown, and packaged resources.

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

Use the installed DSH Desktop application; it starts this profile internally through `dsh --profile desktop`.

### Install into a profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-desktop-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-desktop-app
```

In-box bundles resolve from the `dsh` installation, and reconciliation activates this dependency from its `dsh.bundle.patch` declaration. A normal command shell cannot use the resulting profile because the transport requires an Electron Utility Process parent channel.

### What you get

The carrier opens no HTTP listener. Each Renderer receives a dedicated MessagePort, while the native directory-picker Host and Client rows retain the Windows chooser and its cancellation behavior. The Desktop UI row adds shell integration without duplicating the shared conversation, settings, Session, approval, attachment, or terminal implementations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The static patch inserts four rows: transport, native directory-picker Host, native directory-picker Client, and Desktop UI. The Host transport announces readiness only after the Loader settles. The application transfers ports after each window finishes loading and requests a bounded Host shutdown before it terminates the Utility Process tree.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Electron carrier and native interaction rows |
| [`src/index.ts`](src/index.ts) | Empty package entry for the installable bundle |
| [`tests/desktop-app.spec.ts`](tests/desktop-app.spec.ts) | Manifest and native Host/Client pair checks |
| — | No runtime invariant companion is published; this static patch owns no mutable state and each inserted package owns its own lifecycle checks. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop user guide](../../../docs/user/guide/desktop.md) — install and operate the application.
- [Shared GUI bundle](../gui-app/README.md) — the carrier-neutral rows below this layer.
- [Desktop transport](../../desktop/transport/README.md) — MessagePort protocol and shutdown.
- [Desktop UI](../../client/ui-desktop/README.md) — title bar, windows, notifications, and settings.
- [Desktop architecture decision](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.md) — security and lifecycle rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the shared GUI and native interaction packages selected by this carrier.

#### KV Cache effect

The carrier contributes no model-request prefix and does not change cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints match the first Windows-only application release.

- **The bundle requires an Electron Utility Process** — launching `dsh --profile desktop` in ordinary Node fails before serving a client.
- **The profile is startup-only** — user patch and plugin changes require the Desktop-owned Host restart path.
- **Remote Hosts are unsupported** — the carrier accepts only ports transferred by the local Electron main process.
- **Native directory selection assumes a local interactive Windows session** — unattended and remote deployments should use another carrier and picker.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
