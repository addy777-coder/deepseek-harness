---
description: "Offline native VPN checks and an explicit live company-model acceptance run through the supported dsh launcher."
---

# VPN acceptance tests

English | [中文](README.zh.md)

The [helper build](../scripts/build.ps1) runs native packet/CONNECT tests, offline process checks and source-package restoration on each supported target. These checks need no company credentials. The separate live fixture verifies the saved company provider through the production credential, network and pi-ai services. The native CI matrix verifies macOS/Linux binaries; a maintainer with saved company credentials owns real VPN acceptance on each target.

Run `pwsh -File native/vpn/tests/dependency-install.test.ps1` to check bounded dependency-download retries with local subprocess fixtures. It verifies recovery and rejection without network requests or compiled VPN binaries.

## Live run

Save the VPN profile and account in the desktop settings, configure the company provider to use VPN and Anthropic Messages, and save its model credential. Disconnect the desktop VPN before launching the separate fixture. The fixture owns its own tunnel and leaves external OpenVPN clients untouched; an active external OpenVPN process or competing helper fails acceptance.

Review [the fixture patch](live-acceptance.patch.yml). It selects provider `gongsi` and the saved default model; replace `model` with the exact saved company model id when that differs. The patch contains only the executable path, provider/model, request budgets and report path. It reads the normal Harness home and credential service; use the same Harness home as the desktop.

From the repository root, run the outer acceptance script with PowerShell 7:

```powershell
& native/vpn/tests/run-live-acceptance.ps1
```

The script records system routes, DNS and interfaces before starting any Harness plugin, refuses active external OpenVPN processes or existing helpers, and launches `node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch native/vpn/tests/live-acceptance.patch.yml`. Its child inherits the selected Harness home and selects the current platform's helper. PowerShell 7 must be on `PATH`; Linux snapshots require `iproute2`. `-ReportPath` selects a new host report file; `-RunTimeoutSeconds` bounds the whole run (default 1800), and `-ShutdownGraceMs` bounds launcher termination (default 10000). The script terminates only its own launcher process tree when the run exceeds that deadline.

The fixture disables the ordinary headless task parser and runner, waits for `appReady`, connects the native provider, and performs text streaming, tool-call replay, long output, cancellation, a subsequent request, and model discovery. Set `checkDiscovery: false` only when the company endpoint does not implement model listing; the report marks that check as not requested.

The fixture compares network snapshots around its model requests, disconnects its owned tunnel, verifies that no helper remains, and requests `appExit`. The outer script compares the final network state with the baseline taken before startup, including automatic connection, and checks external VPN processes and helper exit again. Direct CLI invocation is useful for diagnostics but does not provide that pre-start baseline.

The script writes a host report and a sibling `.fixture.json` report under the helper's ignored `.cache/` directory by default. Stdout identifies the host report path and pass/fail result. Reports contain counters and fixed failure codes; they contain no credentials, endpoint addresses, model text or raw network snapshots. Launcher stdout/stderr stay in memory and are not printed or saved. Existing report files are never overwritten.

Exit code 0 means every requested check passed. A connection, model, cleanup or report-write failure exits with code 1. Authentication failures require fixing saved credentials; the fixture does not alter accounts or retry policy. Real-company execution is an explicit acceptance step and is not part of the offline build.

## Offline fixture checks

These commands inspect composition without activating plugins and test the live fixture against in-memory services:

```powershell
node --import tsx/esm apps/cli/src/bin.ts --profile headless --dump-config --patch native/vpn/tests/live-acceptance.patch.yml
node --import tsx/esm --test native/vpn/tests/live-acceptance-plugin.test.mjs
& native/vpn/tests/run-live-acceptance.test.ps1
```

The importable [acceptance runner](live-acceptance.ts) can also be called by an already initialized desktop test context. [The plugin](live-acceptance-plugin.ts) owns readiness, connection, network snapshots, reporting and shutdown around that runner.
