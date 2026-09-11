---
description: "Save company VPN settings, control application-owned connections, and read password-free connection state from desktop settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-vpn-controller

English | [中文](README.zh.md)

## Summary

Save a company VPN profile and account, connect or disconnect the application tunnel, and read its current status. Settings commands accept file contents and a write-only password. Connection failures remain visible after a successful save so the settings page can clear its password draft.

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

The desktop composition mounts this controller beside the application network provider and exposes the generated `vpn` Remote namespace to the [VPN settings page](../../client/ui-vpn/README.md). A deployment without a network provider returns an unsupported status and rejects connection commands.

### Configuration

Mount the controller in a composition that provides `network`; it has no configuration fields:

```yaml
- name: '@deepseek-ai/dsh-api-vpn-controller'
```

The [configuration catalog](../../../docs/config-catalog.md) owns generated plugin configuration references. VPN profile contents and credentials belong to the network provider, rather than controller configuration.

### Saving and connection controls

Imports contain display file names and UTF-8 contents. The controller rejects undeclared fields, more than 16 referenced files, and oversized input strings. The network provider validates profile syntax, certificate references, compatibility, and credentials before persistence. Omitting the profile or password retains its saved value.

On the first successful VPN save, an existing `gongsi` provider using `anthropic-messages` is configured to use VPN through a revision-checked settings mutation. Other provider protocols and subsequent saves preserve the provider's network selection. If this mutation fails, the saved account remains available and the response directs the user to configure the provider manually. A connection startup exception also returns a saved result with a sanitized failure.

A newer disconnect prevents a pending save or reconnect from starting a late connection. Cancellation after persistence keeps the saved account and skips connection startup. The network provider owns active connection cancellation and tunnel teardown.

### Client lifecycle

The Client `vpn` service exposes an observable snapshot and load, save, connect, and disconnect commands. Host lifecycle events update the snapshot without polling; transport recovery triggers a fresh read. New commands invalidate pending reads, and superseded replies cannot overwrite later commands or events. Save returns whether persistence succeeded, independently of connection success. Disposal aborts outstanding calls, removes listeners, suppresses publications, and waits for every owned call to settle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host validates the Remote request and delegates credential persistence and connection resources to the network capability. The Client stores only the redacted view and operation codes; the settings component owns local password and file drafts. Host and Client compile separately, with generated Remote declarations connecting their types.

No runtime invariant companion is published: this controller owns no independently persisted state to compare with the network provider. Deferred operation tests exercise ordering and disposal, and the Host fixture mounts the controller through Loader.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the form, transport ownership, and settings writes.

- [VPN settings page](../../client/ui-vpn/README.md) — profile import and local credential drafts.
- [Network capability](../../network/network/README.md) — model destinations and tunnel lifecycle.
- [User settings](../../settings/settings/README.md) — revision-checked provider configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as this controller registers no prompt, tool, or session event and keeps VPN credentials outside model inputs.

#### KV Cache effect

No effect; settings operations do not construct or send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This controller exposes one application VPN configuration:

- VPN support depends on the mounted provider; the desktop implementation supports Windows/Linux x64 and macOS x64/arm64.
- Provider selection and credential persistence are separate writes. A provider-selection failure after persistence requires correcting that provider's settings.
- Native compatibility, DNS, retries, request routing, and process cleanup belong to the network provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
