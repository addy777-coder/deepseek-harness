---
description: "Use a native OpenVPN tunnel for selected private model endpoints without changing Windows routes, DNS, or network adapters."
kind: "package-reference"
---

# @deepseek-ai/dsh-network-openvpn

English | [中文](README.zh.md)

## Summary

Use this provider to reach private model endpoints through an application-owned OpenVPN connection on Windows x64. Import the VPN profile and its referenced certificates, save the account, and choose VPN for the model provider. The tunnel leaves Windows adapters, routes, and DNS unchanged. Requests stop when the tunnel is unavailable.

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

Mount this provider in a supported `dsh` profile together with settings, credentials, and local subprocess providers. Configure private model routes through the [pi-ai adapter](../../llm/llm-pi-ai/README.md); its VPN mode supports Anthropic Messages with API-key authentication and SSE. Other model providers retain their direct connection choice.

### Native runtime

Production profiles set `executablePath` to the absolute Host path of the packaged `dsh-vpn.exe`. Supply `executableSha256`, or retain the adjacent `dsh-vpn.exe.sha256` file. Distribute the complete asset directory, including licenses and corresponding source, as described by the [native helper](../../../native/vpn/README.md). Source execution defaults to the repository's `native/vpn/dist/windows-x64/dsh-vpn.exe`; production installation must provide its own explicit asset path. A missing executable or checksum, or a digest mismatch, refuses connection before the process starts.

### Profile and account

Import `.ovpn` text and every referenced certificate or key file through the VPN settings surface. References are resolved only from the selected files by unique filename; the importer never opens a path named inside a profile. Inline PEM material is preserved. Executable hooks, nested configuration files, PKCS#12 imports, unresolved references, and malformed input are rejected.

Save the VPN username and password with the imported profile. The provider stores the profile, username, and password in a `network-openvpn/profile-<id>` credentials grant. The `network-openvpn` settings section stores only its credential key and `autoConnect` preference. Configuration reads and events omit the password and profile contents. Saving replaces the configuration and disconnects the active tunnel; connect separately when ready. `autoConnect` restores a saved connection when the application starts.

### Failure and shutdown

The provider retries transient connection failures with bounded backoff. Authentication, certificate, unsupported-profile, and native-integrity failures require correction instead of repeated connection attempts. Disconnecting, replacing a registered model destination, or unloading the provider cancels affected requests and waits for helper shutdown. HTTP redirects are rejected, and requests never retry through the Host network.

### Deployment configuration

The provider resolves these settings before starting a helper. VPN account details belong in the credentials service, outside these fields.

| Field | Default | Meaning |
|---|---|---|
| `executablePath` | source-tree helper path | Absolute packaged helper path in production |
| `executableSha256` | adjacent checksum file | Expected executable SHA-256 |
| `dshHome` | resolved dsh home | Working directory for managed helper processes |
| `connectTimeoutSeconds` | `60` | Connection attempt timeout |
| `shutdownGraceMs` | `5000` | EOF shutdown grace before process-tree termination |
| `reconnectDelayMs` | `2000` | Initial transient-failure retry delay |
| `reconnectMaxDelayMs` | `30000` | Maximum transient-failure retry delay |
| `maxConnections` | `16` | Concurrent proxy streams |
| `headerTimeoutMs` | `5000` | CONNECT-header deadline |
| `targetConnectTimeoutMs` | `30000` | Tunnel target connection deadline |
| `pollIntervalMs` | `10` | Userspace IP-stack timer interval |
| `maxPendingPacketBytes` | `1048576` | Pending tunnel packet byte limit |
| `maxProfileBytes` | `524288` | Aggregate import and expanded-profile byte limit |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider launches the native OpenVPN3/lwIP helper through the managed subprocess service. One startup JSON message carries the profile, account, random proxy token, configured destinations, and resource limits through stdin. The helper exposes an authenticated loopback CONNECT proxy after the tunnel is ready. Undici preserves the original model URL and HTTPS verification while sending the request through that proxy.

Each model consumer registers an origin and API path. The HTTP dispatcher checks that registration for every request and combines caller, destination, and connection cancellation. Changing destinations restarts the helper with the current allowlist. The parent drains protocol status without retaining raw native output, closes stdin for graceful shutdown, and waits for process-tree exit after any required termination.

Credentials and settings changes reload the saved configuration. Serialized writes and connection intent tracking prevent older refresh work from overriding a later disconnect. No invariant companion is published: destination admission and helper protocol validation run on their executed paths; the native allowlist is not exposed as a second independently readable registry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Network service](../network/README.md) — destination registration, HTTP requests, and redacted status.
- [Native helper](../../../native/vpn/README.md) — build, supported protocols, and source distribution.
- [pi-ai adapter](../../llm/llm-pi-ai/README.md) — model-side VPN requirements.
- [Credentials service](../../credentials/credentials/README.md) — storage ownership and record access.

-----

<a id="model-experience"></a>
## Model Experience

None, as the VPN transports existing model requests without adding content.

#### KV Cache effect

None. The tunnel preserves model request contents and does not add session context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the supported deployment.

- **Windows x64 only.** Other platforms report unsupported; no system VPN or direct-network fallback is provided.
- **One saved VPN account.** Challenge authentication, password-protected private keys, and external PKI are unsupported.
- **Selected model HTTP traffic only.** The provider is not a system proxy; the native helper's IP and transport limits apply.
- **Anthropic Messages is the shipped model integration.** Other provider APIs and WebSocket transports require separate consumer support.

<a id="dev-note"></a>
### Dev Note

None.
