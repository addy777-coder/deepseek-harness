---
description: "Shared GUI profile layer for browser and Desktop carriers, adding sessions, workspaces, settings, approvals, terminal views, and the complete client plugin roster."
kind: "package-bundle"
---

# @deepseek-ai/dsh-gui-app

English | [中文](README.zh.md)

## Summary

`dsh-gui-app` gives a base-backed profile the complete interactive GUI Host and Client composition without selecting a physical carrier. The shipped `web` and `desktop` profiles include it between `dsh-base` and their carrier bundle. It adds Session, workspace, settings, approval, terminal, and client-plugin rows, while the later carrier decides whether bytes travel over authenticated HTTP or Electron MessagePort IPC. A custom profile must add exactly one compatible carrier after this layer.

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

The normal path is a shipped profile, which already keeps this layer in the correct order.

### Install into a profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-gui-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-gui-app
```

In-box bundles resolve from the `dsh` installation. Reconciliation activates a dependency only when its manifest declares `dsh.bundle.patch`; a missing patch declaration fails as a profile layer. Add `dsh-base` before this bundle and add a Web or Desktop carrier after it.

### What you get

The layer provides the GUI-specific prompt defaults, in-memory Session search setting, workspace and controller services, API Remotes, Connection core, client-module registry, client runner, and the complete shared UI roster. It also moves per-agent tools behind the preset registry so every GUI Session can select its own agent composition.

The [usage page](../../client/ui-usage/README.md) reads directory-wide history through the [usage controller](../../api/usage-controller/README.md). Both carriers share its read limits, Client model, and Settings contribution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a static patch document. It restates the GUI values that the base layer deliberately omits, inserts transport-neutral Host and Client rows, disables process-wide agent rows, and mounts the preset registry. Carrier-specific HTTP, browser authentication, Electron transport, native window integration, and directory-picker selection remain outside this layer.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Shared GUI values, services, client roster, and agent-plane transfer |
| [`src/index.ts`](src/index.ts) | Empty package entry for the installable bundle |
| — | No runtime invariant companion is published; the package is a static patch carrier and each inserted package owns its runtime relations. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — all shipped profile layers.
- [app-boot profiles](../../boot/app-boot/README.md#profiles) — layer order and patch lifecycle.
- [Web carrier](../web-app/README.md) — authenticated HTTP and browser startup.
- [Desktop carrier](../desktop-app/README.md) — Electron IPC and native integration.
- [Desktop architecture decision](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.md) — why the GUI and carriers are separate.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns its prompt, tool, and Session effects.

#### KV Cache effect

The bundle adds no request prefix of its own; the selected preset and inserted packages own cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints keep the shared layer independent of how a user reaches it.

- **The bundle is not a complete application** — a profile must place `dsh-base` before it and one carrier bundle after it.
- **Carrier behavior cannot live here** — ports, cookies, protocol registration, and native windows belong to the selected carrier.
- **Patches replace whole configuration objects** — later profile overrides must restate every field they retain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
