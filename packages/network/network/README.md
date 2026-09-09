---
description: "Register private model destinations and issue cancellable HTTP requests through an application-owned VPN service."
kind: "package-reference"
---

# @deepseek-ai/dsh-network

English | [中文](README.zh.md)

## Summary

Model adapters use this service to send requests through an application-owned VPN. Consumers register configured API roots and keep each HTTP request under its registered destination. Missing or disconnected VPN service causes a request failure. Configuration surfaces can read redacted status, save an imported profile, and connect or disconnect the tunnel.

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

Mount a provider such as [network-openvpn](../network-openvpn/README.md) in a supported `dsh` profile. This package declares `ctx.network`; it does not open a tunnel itself and has no plugin configuration fields.

### Model consumers

Register an API root through `ctx.effect()` and retain the returned disposer. The branded `NetworkTargetId` identifies the registration; `fetch()` accepts only URLs under that destination's origin and path. Disposing the registration revokes access and cancels its active requests. A consumer choosing direct networking does not register a destination or call this service.

The [pi-ai adapter](../../llm/llm-pi-ai/README.md) supplies the shipped model consumer. Its VPN mode supports Anthropic Messages HTTP streaming and requires a saved endpoint and explicit API-key reference. Provider URLs remain unchanged.

### Configuration consumers

`get()` returns redacted configuration and connection state. `save()` accepts profile contents, selected reference-file contents, a login name, a write-only password, and the startup preference; saving and connecting are separate operations. `disconnect()` settles after owned requests and the helper process stop. The `network/changed` event carries the same redacted status fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service separates model destinations from VPN authentication. Model consumers own their API roots and request cancellation; the provider owns connection state, credentials, process lifetime, and HTTP dispatch. The request API never permits a fallback to direct networking. Providers must preserve response streaming and stop requests when their destination registration or connection is revoked.

The root entry declares the abstract service and branded identifier constructor. The `./types` entry exports the shared request, status, destination, and event declarations for other compilation faces. No invariant companion is published: this definition owns no concrete connection state or independent observations; providers enforce destination and lifecycle checks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [OpenVPN provider](../network-openvpn/README.md) — supported platform, imports, credentials, and reconnect behavior.
- [Network package map](../README.md) — packages in this capability.
- [Model settings](../../client/ui-settings-models/README.md) — the provider connection selector.

-----

<a id="model-experience"></a>
## Model Experience

None, as this service only selects HTTP destinations and exposes redacted local status.

#### KV Cache effect

None. The service changes HTTP routing without adding or rewriting model inputs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the service's supported use.

- **A provider is required.** The Service Definition does not implement a tunnel or direct networking.
- **HTTP requests require registration.** WebSocket clients and arbitrary destination discovery are outside this API.
- **Status is local runtime state.** It is not a model message or durable session event.

<a id="dev-note"></a>
### Dev Note

None.
