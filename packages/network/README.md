---
description: "The network package group: application-owned model connections and the native OpenVPN provider."
kind: "package-group"
---

# network/ — Private model connections

English | [中文](README.zh.md)

## Summary

This family lets configured model providers use an application-owned VPN connection. The service defines destination registration and cancellable HTTP requests; its OpenVPN provider owns the tunnel and local settings. Model adapters choose whether each provider uses this connection. The tunnel does not change the computer's routes or DNS.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose the service for consumer integration and the provider for a supported local tunnel.

| Package | Role |
|---|---|
| [`network`](network/README.md) | Service Definition for registered destinations, HTTP dispatch, and VPN configuration |
| [`network-openvpn`](network-openvpn/README.md) | Windows x64 provider using the native OpenVPN helper |

<a id="related-documentation"></a>
## Related documentation

- [Network subsystem](../../docs/subsystems/network.md) — service and provider composition.
- [pi-ai model adapter](../llm/llm-pi-ai/README.md) — per-provider direct or VPN selection.
- [Native helper](../../native/vpn/README.md) — build, process protocol, network limits, and distribution.
- [Capability seams](../../docs/capability-seams.md) — Service Definition, Service Provider, and Consumer roles.

<a id="dev-note"></a>
## Dev Note

None.
