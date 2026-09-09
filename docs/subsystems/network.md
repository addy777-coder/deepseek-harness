# Application networking

English | [中文](network.zh.md)

The [network capability](../../packages/network/README.md) carries selected model requests through an application-owned tunnel. The [OpenVPN provider](../../packages/network/network-openvpn/README.md) implements it; the [VPN controller](../../packages/api/vpn-controller/README.md) and [pi-ai adapter](../../packages/llm/llm-pi-ai/README.md) consume it. Configuration and connection events never enter model context.

## Destination ownership

### NetworkTargetId

A branded id belongs to the consumer registering a configured destination. Registration returns a disposer that cancels its requests and withdraws the destination. The provider refreshes the helper's allowlist when registrations change. Duplicate ids reject registration.

### NetworkTarget

A target contains an absolute HTTP or HTTPS API root without URL credentials, queries, or fragments. Requests must retain its origin and path prefix; redirects fail. The native CONNECT proxy separately restricts host and port and requires a random credential for each helper launch.

## Local configuration

### SaveVpnRequest

A save carries an optional imported profile, selected reference files, a username, an optional replacement password, and the startup preference. Omitted profile or password retains its saved value. The importer inlines user-selected certificates and never opens a Host pathname from the profile. Validation and cancellation precede the durable commit.

### VpnSettingsView

The view exposes platform support, profile filename, username, password-presence flag, startup preference, connection state, and a sanitized failure code. It contains neither profile text nor passwords. The `network-openvpn` settings namespace stores only a credential-record key and startup preference; the provider owns a `grant` under the same credential scope containing the complete profile and account data.

## Connection lifetime

The provider publishes `unconfigured`, `disconnected`, `connecting`, `connected`, `reconnecting`, or `error`. Automatic startup uses saved credentials. Network failures schedule bounded exponential reconnect delays; authentication and unsupported-configuration failures stop retries. Explicit disconnect cancels pending connection intent. A revoked target, disconnected tunnel, or absent service fails the selected model request without direct fallback.

The helper receives its bootstrap through a private stdin pipe. Host disposal closes the pipe and awaits process-tree exit; a broken parent pipe also stops the helper after an abnormal Host exit. The implementation creates no system adapter and applies no operating-system routes or DNS settings. The [native distribution](../../native/vpn/README.md) owns protocol and platform restrictions.

The [application-owned VPN decision](../../.agents/notes/implemented/architecture/2026-09-09-application-owned-vpn.md) records provider isolation, credential ownership, and corresponding-source requirements.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnetwork--networkservice-abstract-seam"></a>

### `ctx.network` — `NetworkService` (abstract seam)

Application-owned tunnel service. Consumers register configured model destinations through effects. Requests fail when the tunnel is unavailable; implementations must never retry them through host networking.

```ts cordis-catalog
/** Read local VPN state without exposing credentials.
 * @returns redacted configuration and current connection state.
 */
abstract get(): Promise<VpnSettingsView>

/**
 * Validate an import and commit its credential reference and startup preference.
 * @param request - local profile files and credentials; passwords are write-only.
 * @param signal - cancels validation before the durable commit.
 * @returns settlement after persistence; connection is a separate operation.
 */
abstract save(request: SaveVpnRequest, signal?: AbortSignal): Promise<void>

/** Start a connection with the saved profile and credentials.
 * @returns settlement after connection succeeds or its redacted failure is published.
 */
abstract connect(): Promise<void>

/** Cancel pending connection intent and stop the current tunnel.
 * @returns settlement after all owned requests and the helper process have stopped.
 */
abstract disconnect(): Promise<void>

/**
 * Allow one configured model destination until its consumer unloads.
 * @param id - consumer-owned destination identifier.
 * @param target - absolute API root; credentials and fragments are rejected.
 * @returns an idempotent disposer that revokes this registration and its active requests.
 */
abstract registerTarget(id: NetworkTargetId, target: NetworkTarget): () => void

/**
 * Fetch through the owned tunnel while preserving response streaming and cancellation.
 * @param id - an active registered destination.
 * @param input - HTTP request URL under the registered API root.
 * @param init - Fetch options; redirects never escape the registered destination.
 * @returns a streaming response, or a sanitized failure without direct fallback.
 */
abstract fetch(id: NetworkTargetId, input: RequestInfo | URL, init?: RequestInit): Promise<Response>
```

Source: [`packages/network/network/src/index.ts`](../../packages/network/network/src/index.ts)

<a id="ctxvpncontroller--vpncontroller"></a>

### `ctx.vpnController` — `VpnController`

Exposes password-free VPN status and write-only configuration commands.

```ts cordis-catalog
/**
 * Read the application's current VPN status.
 * @param signal - cancels a read before it starts.
 * @returns redacted VPN state, including unsupported deployments.
 */
@Remote async get(signal?: AbortSignal): Promise<VpnSettingsView>

/**
 * Save validated credentials and start the tunnel; the existing company provider opts into VPN on first configuration.
 * @param request - imported files and write-only password.
 * @param signal - cancels profile validation before persistence.
 * @returns redacted state after the connection attempt; connection failures remain visible in its failure field.
 */
@Remote async saveAndConnect(request: SaveVpnRequest, signal: AbortSignal): Promise<VpnSettingsView>

/**
 * Replace the current tunnel with a fresh connection attempt.
 * @param signal - prevents connection startup if cancelled before replacement finishes.
 * @returns redacted state after the attempt settles.
 */
@Remote async connect(signal?: AbortSignal): Promise<VpnSettingsView>

/**
 * Cancel pending connection intent and stop the active tunnel.
 * @param signal - cancels before shutdown starts; an accepted shutdown always finishes.
 * @returns redacted state after all owned tunnel resources have stopped.
 */
@Remote async disconnect(signal?: AbortSignal): Promise<VpnSettingsView>
```

Source: [`packages/api/vpn-controller/src/index.ts`](../../packages/api/vpn-controller/src/index.ts)

<a id="network-events"></a>

### `network/*` events

<a id="networkchanged--emit"></a>

#### `network/changed` — emit

Redacted VPN state after the provider commits a configuration or lifecycle change.

```ts cordis-catalog
/**
 * Redacted VPN state after the provider commits a configuration or lifecycle change.
 * @mode emit
 * @param view - password-free local configuration and connection state.
 */
'network/changed'(view: VpnSettingsView): void
```

Source: [`packages/network/network/src/types.ts`](../../packages/network/network/src/types.ts)
<!-- END GENERATED cordis-surface -->
