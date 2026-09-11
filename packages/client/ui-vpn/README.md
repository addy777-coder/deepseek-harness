---
description: "Import an OpenVPN profile and referenced certificates, save VPN credentials, and manage the desktop application's private model connection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-vpn

English | [中文](README.zh.md)

## Summary

Configure the company VPN from desktop settings and save the account to start connecting. Import an OpenVPN profile with its referenced certificates, choose automatic connection at startup, and inspect connection failures. The form keeps password drafts local and clears them after the Host confirms persistence.

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

Open **Settings → VPN** in the desktop application. This page requires the [VPN controller](../../api/vpn-controller/README.md), locale service, and settings renderer. Unsupported hosts display the supported operating systems and CPU architectures and disable configuration.

### Configure a connection

Choose an `.ovpn` file and add the CA, certificate, or key files that it references. File names must match those references. Enter the VPN username and password, choose whether to connect automatically at startup, and select **Save and connect**. The status reports whether the connection is active or failed.

Leave the password blank to retain an existing saved password. A successful save clears selected files and the password draft, including when connection startup fails. Replacing referenced files requires selecting the profile again. Connection status updates preserve unsaved form edits.

Use **Disconnect** to stop an active connection or a pending Host command. **Reconnect** uses saved settings and is disabled while the form contains edits. **Refresh** reloads the current state. Only model providers configured to use VPN use the private connection.

### Configuration

This plugin has no configuration fields. The desktop composition mounts its inert Host entry; the Client contribution registers in the settings section through the controller, locale, and renderer dependencies declared by the package. The [configuration catalog](../../../docs/config-catalog.md) owns generated plugin configuration references.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The renderer subscribes to the controller's public snapshot. The form reads selected browser files only when saving and sends display file names with their contents, without browser paths. Passwords remain in component state until the save settles; saved passwords never return from the controller. The page renders localized operation codes and ignores native exception messages.

English and Chinese dictionaries, settings registration, and snapshot subscription follow their owning plugin or component lifetimes. No runtime invariant companion is published: the page owns temporary form state, with no independent durable state to reconcile. Component tests record local HTML expectations for unconfigured, connected, and failed states.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the settings commands and their network resources.

- [VPN controller](../../api/vpn-controller/README.md) — persistence outcomes and operation ordering.
- [Network capability](../../network/network/README.md) — registered model destinations and tunnel ownership.
- [Settings renderer](../ui-settings/README.md) — the settings sections hosting this page.

-----

<a id="model-experience"></a>
## Model Experience

None, as this settings page registers no prompt, tool, or session event and does not add VPN credentials to model inputs.

#### KV Cache effect

No effect; editing the form does not construct or send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The page manages one saved VPN configuration:

- The desktop VPN implementation requires Windows/Linux x64 or macOS x64/arm64, and a compatible company profile.
- The page cannot select an external OpenVPN client's active connection or recover its password.
- Closing the page discards unsaved drafts; persisted connection resources remain owned by the network provider.
- Profile validation, credential storage, startup recovery, and model routing are provided by the Host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
