# Agent Note: Official application foundation with local networking and usage extensions

Status: implemented

English | [中文](2026-09-19-official-foundation-with-local-extensions.zh.md)

## Problem

Independent Desktop carriers, sidebar state, and image-preparation hooks depend on different Session and application interfaces. Combining their source files can preserve incompatible assumptions even when a text merge succeeds. Private model connectivity and cross-session usage still need their own supported consumers.

## Decision

The [official Desktop application](../../../../apps/desktop/README.md), shared Web application, Session formats, model-request lifecycle, sidebar, and release family own the product foundation. Shared manifests use the official release version. The private MessagePort carrier, custom Desktop publisher and updater, sidebar sections, and request-context image recognizer are absent.

The [network capability](../../../../packages/network/README.md) remains an explicit opt-in for each pi-ai provider. Direct providers retain the official SDK behavior. VPN providers require a saved Anthropic Messages endpoint, an API-key reference, and private HTTP dispatch; failed tunnel requests never fall back to direct networking. Deployments supply the native helper independently of the official Desktop installer.

The [usage controller](../../../../packages/api/usage-controller/README.md) reads the current Session format. Each settled Assistant message or attempt contributes at most one usage sample. Final message usage takes precedence over its embedded stream; otherwise the stream retains the reporting timestamp. Token normalization uses the same function as the official turn panel, including rejection of incomplete or inconsistent counts. Unsettled streams are not durable usage evidence.

The superseded [Desktop carrier](../../archived/architecture/2026-09-03-windows-desktop-client.md), [release publisher](../../archived/architecture/2026-09-11-cross-platform-desktop-releases.md), [updater](../../archived/feature/2026-09-09-desktop-in-app-update.md), [image recognizer](../../archived/feature/2026-09-04-text-model-image-recognition.md), [sidebar sections](../../archived/feature/2026-09-14-sidebar-sections.md), [Desktop navigation](../../archived/bug-fix/2026-09-19-desktop-session-navigation-and-export.md), and [process disclosure](../../archived/bug-fix/2026-09-19-paged-turn-process-disclosure.md) decisions remain frozen historical records. The [VPN decision](2026-09-09-application-owned-vpn.md) and [usage decision](../feature/2026-09-08-usage-statistics-from-session-history.md) retain their independent ownership and isolation rationale.

## Alternatives considered

**Combine both application carriers.** Their Host transport, plugin lifecycle, release distribution, and Client assumptions differ. One complete carrier keeps those relationships under one owner.

**Retain obsolete Session events for statistics or image recognition.** Parallel event formats would undermine the official persistence and request-reconstruction rules. Statistics adapts to current records. Reintroducing image recognition requires a current logged extension point, explicit consent to the visual route, complete reports, and durable reuse without rewriting a prepared request.

**Remove every local extension.** This discards private endpoint access and cross-session accounting even though both can use current services without replacing the application carrier.

## Consequences

Desktop signing and updates follow the official implementation; the custom GitHub installer publisher and Linux Desktop packaging are not retained. The native VPN helper still has its own platform builds, integrity verification, licenses, and corresponding-source obligations. Actual company VPN access remains a separate credentialed acceptance check.

History statistics keeps retries separate, excludes inherited fork events using the stored cut, and reports unreadable or incomplete histories. It does not restore the removed image-recognition setting, custom sidebar sections, or private Desktop transport.

Windows containment fixtures use directory junctions to exercise real-path escapes without changing host privileges. Final file-symlink rejection remains a separate test and reports an explicit skip when Windows denies link creation; regular-file opening is verified independently.
