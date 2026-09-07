---
description: "Desktop-host integration packages for the Windows Electron client, including its versioned MessagePort transport and lifecycle adapter."
kind: "package-group"
---

# desktop/ — Electron Host integration

English | [中文](README.zh.md)

## Summary

The `desktop/` group connects the shared GUI Host to the Windows Electron application without opening an HTTP listener. Its transport accepts a dedicated MessagePort for each window and carries boot data, RPC, Fetch responses, streams, and client bundles. The Electron main process remains outside model requests and credentials.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`transport/`](transport/README.md) | Connects Electron MessagePorts to the shared GUI services | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [Desktop user guide](../../docs/user/guide/desktop.md) — install, launch, recover, and manage plugins.
- [Desktop carrier bundle](../bundle/desktop-app/README.md) — profile rows that activate the transport.
- [Client module subsystem](../../docs/subsystems/client-modules.md) — transport-neutral boot data and bundle artifacts.
- [Desktop architecture decision](../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.md) — process and security ownership.

<a id="dev-note"></a>
## Dev Note

None.
