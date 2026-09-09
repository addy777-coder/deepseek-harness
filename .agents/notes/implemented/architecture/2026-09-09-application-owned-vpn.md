# Agent Note: Application-owned VPN for selected model providers

Status: implemented

English | [中文](2026-09-09-application-owned-vpn.zh.md)

## Problem

A company model endpoint can require OpenVPN access even though other model providers and local applications use the ordinary network. Requiring a separate VPN client makes application availability depend on another process's configuration and connection lifetime. Starting that client's system tunnel from the application still changes routing for the whole computer and can require elevated privileges.

## Decision

The [network capability](../../../../packages/network/README.md) owns configured HTTP destinations and connection state. Its [OpenVPN provider](../../../../packages/network/network-openvpn/README.md) runs a separate native helper combining OpenVPN3 Core with an in-memory lwIP stack. Windows networking reaches the VPN server; the helper carries model TCP connections and VPN-provided DNS inside the tunnel. It creates no operating-system adapter and changes no system route or DNS setting.

The helper exposes an ephemeral loopback CONNECT proxy. Every launch has a random authentication token and an explicit host/port allowlist. Each consumer owns a branded target registration and its disposer. The Host additionally confines HTTP requests to the registered origin and API path prefix, rejects redirects, and aborts requests when their target is withdrawn. The original endpoint URL remains intact, preserving endpoint TLS verification and protocol headers. A disconnected tunnel or missing network service fails the selected request without direct fallback.

[pi-ai provider profiles](../../../../packages/llm/llm-pi-ai/README.md) select `network: direct | vpn` independently of SSE/WebSocket transport. VPN profiles require explicit Anthropic Messages endpoints and Harness-managed API-key credentials. The adapter passes a private fetch implementation into the real pi-ai SDK; global fetch, proxy environment variables, and unrelated providers retain their own networking. Provider-native OAuth or ambient authentication cannot issue auxiliary requests outside this selected route. [Provider routing](2026-07-14-provider-routed-llm-adapters.md) retains its separate ownership of model identity and replay metadata.

The [VPN settings controller](../../../../packages/api/vpn-controller/README.md) accepts imported profile content and selected reference files. Import never follows a pathname from the profile, and native evaluation rejects unsupported authentication before persistence. The provider stores the complete profile and account as an opaque `grant` under `network-openvpn/profile-<id>`, following [credential-record ownership](2026-08-13-credential-records-and-authorization-flows.md). Ordinary settings contain only that record's key and the startup preference. Status queries and `network/changed` notifications expose a password-presence flag and sanitized failure code, never the password or profile text.

The application owns connection, reconnect, cancellation, and process-tree cleanup. A private stdin pipe delivers bootstrap credentials and ties the helper to the Host's lifetime. Explicit disconnect cancels reconnect intent; authentication failures stop retries. The [Desktop bundle](../../../../packages/bundle/desktop-app/README.md) selects the provider, controller, and settings UI. The Electron application supplies the native artifact and verifies its manifest and executable checksum.

The [native distribution](../../../../native/vpn/README.md) contains the GPL-3.0-only helper, license notices, and corresponding-source ZIP for the linked executable. Desktop packaging retains these assets together. A subprocess keeps the protocol and lifetime explicit; it does not remove the helper's source-distribution obligations.

Desktop [runtime staging](../../../../scripts/stage-desktop-runtime.ts) first validates the root lock with a frozen offline install, then lets pnpm convert workspace paths during offline deployment. Both operations disable lifecycle scripts and retain store-integrity verification. [Resolution verification](../../../../scripts/desktop-runtime-lock.ts) requires every registry package identity and complete `resolution` record, including `integrity` and `tarball`, to match the verified source lock exactly. Concurrent source-lock changes or added, removed, or changed registry resolutions reject staging. Deployment trusts the verified lock because the legacy hoisted path can re-resolve ranges to unverified versions, while the modern metadata recheck can perform network resolution despite offline mode.

## Alternatives considered

**Launch the installed system OpenVPN client or service.** This reduces native implementation work but preserves privileged, computer-wide routing and the external client's configuration and lifetime. It does not provide application-owned model connectivity.

**Set a process-wide proxy or replace global fetch.** This can send unrelated providers and application requests through the tunnel, while SDK auxiliary requests may still choose a different transport. Per-provider SDK injection gives the consumer an explicit HTTP path.

**Rewrite model URLs to a local gateway.** This adds protocol forwarding and changes the URL observed by the SDK. CONNECT preserves the endpoint URL and end-to-end TLS verification.

**Allow arbitrary VPN discovery drafts.** An unsaved endpoint would bypass the configured destination allowlist. VPN discovery requires a saved matching provider, endpoint, and protocol; direct drafts retain the [namespace-keyed discovery workflow](2026-08-04-draft-provider-endpoint-interrogation.md).

## Consequences

Company model requests can use application-owned connectivity while ordinary network traffic retains its existing route. The feature adds a native build, a credential owner, and a separately managed helper lifecycle. Windows x64, IPv4, TCP, VPN-provided plain UDP DNS, and Anthropic Messages define the supported deployment; the native and provider READMEs own detailed restrictions.

VPN configuration and connection state add no model input, session event, or request prefix. Existing model messages remain reconstructable through their normal session records. The transport choice therefore needs no agent-loop or SDK transcript change.

## Verification

Deterministic provider and UI tests cover target ownership, private SDK fetch, Anthropic text/tool streaming, model discovery, cancellation, and refusal of unsaved VPN destinations. Native wrapper and import tests cover pipe framing, redaction, integrity checks, malformed profiles, and bounded process-tree cleanup. The native helper's offline tests cover CONNECT admission and user-space networking.

A company HTTP request through the user-space prototype succeeded. That observation does not establish HTTPS behavior or complete Desktop/pi-ai acceptance; the production [live acceptance runner](../../../../native/vpn/tests/live-acceptance.ts) owns real model streaming, tool replay, long output, cancellation, and subsequent-request validation. Its company execution remains unverified in this record.
