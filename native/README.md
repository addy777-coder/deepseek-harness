# native/

English | [中文](README.zh.md)

Native source and public packages maintained with DeepSeek Harness. The [`landlock-run/` workspace](landlock-run/README.md) owns the Landlock self-restrict-then-exec launcher consumed by the harness, including its architecture, three-package npm family, platform support, development workflow, and [release procedure](landlock-run/docs/release.md).

The [`vpn/` helper](vpn/README.md) carries selected model traffic through an application-owned OpenVPN tunnel on Windows x64, macOS x64/arm64, and Linux x64. Its documentation owns native builds, protocol restrictions, licenses, and corresponding-source distribution; the [network packages](../packages/network/README.md) own configuration and HTTP consumers.

## Workspace and release boundary

`landlock-run/` and its packages belong to the repository's root pnpm workspace and lockfile. Harness consumers use the current workspace entry package during development and CI, so a launcher contract change and its consumer update can land and be tested together.

The main repository's `Landlock Run` workflow builds and tests each supported architecture. `Landlock Run Release` assembles those native artifacts, packs and verifies the three npm tarballs, then optionally publishes them under one launcher version. The entry package retains platform packages as npm optional dependencies, so npm still installs only the package matching the user's operating system and CPU.

The VPN helper has a separate artifact directory containing its executable, integrity manifest, notices, and corresponding-source ZIP. Desktop packaging preserves that complete distribution; the helper is not an npm platform dependency or an installed network driver.
