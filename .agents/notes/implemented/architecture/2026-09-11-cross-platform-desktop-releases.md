# Agent Note: Versioned Desktop releases across native targets

Status: implemented

English | [中文](2026-09-11-cross-platform-desktop-releases.zh.md)

## Problem

Desktop downloads need one complete, identifiable installation set for each source version. A Windows-only tag workflow cannot distribute macOS and Linux dependencies, and independent publishing jobs can expose a release before every platform succeeds. Replacing an existing version also makes its source commit and installer bytes ambiguous.

## Decision

The [Desktop workflow](../../../../.github/workflows/desktop-publish.yml) compares the unified DSH version across a master push. A version increase starts four native builds: Windows x64, macOS arm64 and x64, and Linux x64. Unchanged versions skip builds; version decreases and inconsistent manifests reject the run. Manual dispatch defaults to verification and requires its publish input for publication. The existing npm and Python publication sequences remain separate.

One aggregate publisher owns `v<version>` tags and GitHub Releases. It verifies every installer and updater reference, combines both macOS file lists, and generates SHA256SUMS from the actual published set. It uploads a draft, downloads and verifies the remote bytes, and only then makes the release public. An existing tag must name the selected commit; an existing public release must already contain a valid complete set and is never overwritten. A retry can finish the same commit's draft. Prereleases retain their prerelease flag. Stable publication requests GitHub’s `legacy` Latest selection, which considers release creation date and semantic version.

Each build installs its own native dependency closure and packages the matching VPN distribution. The [application-owned VPN decision](2026-09-09-application-owned-vpn.md) still owns tunnel isolation and credentials. POSIX helper communication retains the Windows JSONL protocol and shutdown semantics while accepting both FIFO pipes and Unix sockets used by Node. It does not introduce system adapters, drivers, privileged services, or network-route changes.

Native dependency caching retains only downloaded archives and vcpkg’s ABI-keyed library cache, separated by target and dependency inputs. Source checkouts, installed trees and application packages are rebuilt and verified. The installer retries only diagnosed transient transfer failures; compilation, permanent HTTP failures and hash mismatches remain fatal. Windows directory-picker fixtures resolve their created directory to its real path because the runner’s TEMP can contain an 8.3 alias while the native chooser returns a long path.

macOS uses ad-hoc signing without Developer ID or notarization. The VPN helper is signed before its manifest digest is calculated and excluded from subsequent Desktop signing. Final package verification checks its bytes and executable permissions. These builds offer manual updates through the releases page because ad-hoc signing does not provide the publisher identity required for a supported macOS update chain.

Linux AppImage distributions use an owned AppRun because the builder’s default launcher can disable Chromium sandboxing. Final-container validation requires that launcher and rejects sandbox-disabling desktop arguments. Ubuntu 24.04 CI grants user namespaces only to the unpacked executable through a temporary AppArmor profile; it retains the host’s global restriction. DEB installation supplies its packaged profile, while AppImage installations require permission for their fixed path.

The [Desktop architecture note](2026-09-03-windows-desktop-client.md) remains the owner of Renderer isolation, Host lifetime, and plugin transactions. The [in-app update note](../feature/2026-09-09-desktop-in-app-update.md) retains the cancellation and full-download decisions. Both remain active because this release policy supersedes their platform and publication details only.

## Alternatives considered

**Publish every master push.** This produces a new installer for changes that retain the same product version or requires a separate generated version scheme. An explicit unified version increase gives users a stable release identifier.

**Publish platforms independently.** This shortens time to the first download but exposes incomplete releases and competing updater metadata. A single aggregate publisher makes all four native results prerequisites for visibility.

**Cross-package another platform's node_modules.** Native modules, helper executables, and platform optional dependencies follow the build host. Native runners and final-package smokes verify the dependency closure actually shipped to users.

## Consequences

Release history maps versions to immutable commits and complete download sets. Four native builds cost more CI time, and any platform failure delays publication without replacing the previous release. Windows and Linux packages have no publisher certificate; macOS users manually approve and replace the downloaded application. Linux initially distributes AppImage and DEB for x64.

Focused tests own version advancement, conflicts, draft retries, missing or modified assets, and updater hashes. Packaged Electron tests exercise each platform's shell and private Host transport; native VPN tests cover framing, lifecycle, admission, and user-space packet handling. Offline tests do not establish real company VPN or model access; that acceptance remains separate and needs a compatible test profile and credentials.
