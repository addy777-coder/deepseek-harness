---
description: "Electron MessagePort transport for the DSH Desktop Host, for maintainers configuring request limits or debugging boot, RPC, bundle, and stream delivery."
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-transport

English | [中文](README.zh.md)

## Summary

`dsh-desktop-transport` lets a sandboxed Electron Renderer use the shared DSH GUI without an HTTP server, TCP port, or browser cookie. The Host accepts one main-process-transferred MessagePort per window and carries startup injections, unary requests, bundle bytes, and pull-driven streams. Choose it only for the `desktop` profile; the Web carrier remains responsible for browser authentication and network request checks. The complete request and response bodies are bounded but buffered in memory.

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

The Desktop carrier bundle mounts this plugin after the shared Connection, API Gateway, client-module, and boot registries are ready.

### When to choose it

Choose this package when an Electron Utility Process owns the Host and the main process can transfer a dedicated port from each Renderer. Do not mount it in a browser or ordinary `dsh` process: activation requires Electron's Utility Process `parentPort` and fails when that channel is absent.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-desktop-transport'
  config:
    maxBodyBytes: 314572800
```

| Field | Default | Meaning |
|---|---|---|
| `maxBodyBytes` | `314572800` | Largest complete Renderer request body accepted in bytes |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-desktop-transport) is the exhaustive source for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The version-1 protocol separates main-process lifecycle frames from window transport frames. The Utility Process reports bootstrap, profile initialization, and Loader settlement before ready, and the main process strictly validates each frame so a startup timeout can identify the last reported phase. The main process transfers a port without inspecting application payloads. The Host validates exact keys and bounded branded ids, then dispatches boot collection, Connection Fetch handlers, API Gateway streams, or immutable client-module artifacts. Each stream advances only after a `stream-pull` frame, so Renderer consumption supplies backpressure; abort and disposal cancel open work and await iterator cleanup.

ArrayBuffers cross Electron's MessagePortMain endpoint through structured cloning. Electron accepts only MessagePorts in that endpoint's transfer list, so the transport does not claim zero-copy body delivery.

| File | Role |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | Versioned frame types and branded request/window ids |
| [`src/index.ts`](src/index.ts) | Utility Process parent channel, readiness, attach, and shutdown |
| [`src/server.ts`](src/server.ts) | Per-window validation, RPC/Fetch dispatch, bundle reads, stream backpressure, and teardown |
| [`tests/server.spec.ts`](tests/server.spec.ts) | Invalid frames, cancellation, backpressure, and quiescent disposal |
| — | No runtime invariant companion is published; the MessagePort owner and each request/stream transaction expose no independent observations that can diverge. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop package map](../README.md) — the Electron Host integration group.
- [Desktop carrier bundle](../../bundle/desktop-app/README.md) — profile composition and native picker rows.
- [Connection](../../client/connection/README.md) — transport-neutral RPC and Fetch dispatch.
- [Client modules](../../client/modules/README.md) — boot injection and bundle artifact ownership.
- [Desktop architecture decision](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.md) — process isolation and payload ownership.

-----

<a id="model-experience"></a>
## Model Experience

None, as this carrier transports existing GUI and Host operations without changing model input.

#### KV Cache effect

None; the transport does not assemble or modify provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the physical Electron carrier rather than the APIs carried through it.

- **Windows Desktop is the only shipped consumer** — the first release does not package this transport for macOS, Linux, or a remote Host.
- **Bodies are cloned and buffered** — Electron MessagePortMain does not transfer ArrayBuffers, and each Fetch response is materialized before delivery.
- **One Host serves all local windows** — a Host crash disconnects every window; the main process waits for an explicit user restart and does not replay work.
- **Startup patches require restart** — the `desktop` profile uses `patchReload: startup`; Desktop plugin transactions restart the Host after an atomic profile replacement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
