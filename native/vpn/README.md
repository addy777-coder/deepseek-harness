---
description: "Windows x64 user-space OpenVPN helper: build, authenticated model transport, lifecycle, limitations and source distribution."
---

# Native VPN helper

English | [中文](README.zh.md)

## Summary

The helper carries selected model requests through an OpenVPN tunnel without creating a Windows network adapter or changing system routes or DNS. OpenVPN3 Core exchanges encrypted tunnel packets with an in-memory lwIP IPv4 stack. An authenticated loopback CONNECT proxy exposes only the destinations selected by the parent process.

## Table of Contents

- [Build and distribute](#build-and-distribute)
- [Process protocol](#process-protocol)
- [Network constraints](#network-constraints)
- [Licenses and corresponding source](#licenses-and-corresponding-source)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

<a id="build-and-distribute"></a>
## Build and distribute

Build on Windows x64 with PowerShell 7, Git, Node.js, and Visual Studio 2022 C++ Build Tools including the Windows SDK, CMake, Ninja and vcpkg. The scripts discover Visual Studio through `vswhere`; `-VsDevCmdPath` selects a specific installation. Run this command from the repository root:

```powershell
pwsh -File native/vpn/scripts/build.ps1
```

The build fetches the revisions in [dependency pins](deps/pins.json), verifies clean source checkouts, and compiles static libraries with a static Microsoft C/C++ runtime. Downloads and intermediate output stay under the helper directory's ignored `.cache/` and `build/` trees. [The custom triplet](deps/triplets/x64-windows-dsh-vpn.cmake) owns linkage; [the build script](scripts/build.ps1) runs CTest and offline process tests before packaging, then verifies source restoration. The tests use synthetic packets and a test-owned loopback listener; they do not authenticate against a company server.

The output is `dist/windows-x64/`: the executable, its SHA-256 file, an asset manifest, licenses, a compiled OpenVPN source audit, and a corresponding-source ZIP. The manifest lists the relative path, SHA-256 and size of every other asset. Distributors retain the entire directory and verify its manifest before placing it in desktop resources. The package rejects unexpected non-system DLL imports. `-SkipPackage` builds and tests without distribution output; `-LocalDependenciesPath` reuses an installation with matching dependency provenance.

The source ZIP contains the helper, exact upstream source archives, library source archives, and all selected vcpkg port patches. To use those supplied sources, extract the ZIP into a fresh directory and run:

```powershell
pwsh -File scripts/restore-sources.ps1
pwsh -File scripts/build.ps1
```

Restoration verifies source hashes and configures local overlay ports. Build tools remain prerequisites; vcpkg may download its portable build tools. A modified or incomplete restored dependency tree is rejected. [The restoration script](scripts/restore-sources.ps1) owns the corresponding-source layout.

<a id="process-protocol"></a>
## Process protocol

The parent launches `dsh-vpn.exe` with piped stdin/stdout and no credentials in arguments or environment variables. It sends one UTF-8 JSON line, then keeps stdin open. EOF or any subsequent stdin byte requests shutdown. The helper checks the pipe every 100 milliseconds during connection processing. The parent waits for process exit before starting a replacement.

The bootstrap requires `profileContent`, `username`, `password`, `proxyToken`, `targets` and the runtime fields below. `profileContent` is a complete inline profile: the parent resolves imported CA, certificate and key references before launch. The native helper never follows profile file paths. The proxy token is a per-launch secret of 32–256 bytes without CR/LF; the parent retains it only for authenticated proxy requests.

| Runtime field | Accepted range | Meaning |
|---|---|---|
| `connectTimeoutSeconds` | 1–300 | OpenVPN connection deadline |
| `maxConnections` | 1–32 | Concurrent proxy connections and tunnel streams |
| `headerTimeoutMs` | 100–60000 | Proxy header admission deadline |
| `targetConnectTimeoutMs` | 100–300000 | Tunnel DNS/TCP connection deadline |
| `pollIntervalMs` | 1–1000 | lwIP timer polling interval |
| `maxPendingPacketBytes` | 65536–8388608 | Queued outgoing tunnel packet bytes |

`targets` contains up to 64 `{host, port}` entries with unique case-insensitive host/port combinations. An empty list denies every destination. Hosts are IPv4 addresses or DNS names; ports are 1–65535. Bootstrap input is bounded to 1 MiB. CONNECT admission accepts only an exact configured host and port, HTTP/1.1, and `Proxy-Authorization: Bearer <proxyToken>`; its headers are bounded to 8192 bytes. The proxy listens on an ephemeral IPv4 loopback port.

Stdout contains JSONL events with `event` and `error` fields. OpenVPN event names are retained with their actual error flag; log messages and event details are suppressed. `profile-evaluated` reports acceptance and required authentication features. `proxy-ready` adds `port` and `dnsConfigured`; the parent must wait for it before forwarding requests. `stopped` ends an orderly shutdown, while fatal failures end with exit code 2. Successful evaluation and orderly shutdown exit with code 0.

An evaluation bootstrap contains only `profileContent` and `evaluateOnly: true`. It validates the inline profile without credentials, proxy creation or network traffic. The parent interprets the authentication requirements before offering connection. A successful evaluation does not prove server compatibility or network reachability.

The importable [live acceptance runner](tests/live-acceptance.ts) takes an already initialized desktop test context and an explicit model selection and request budget. The caller runs it only after saving credentials in the settings UI and connecting. It uses the production credential, network and pi-ai services for Anthropic Messages text streaming, tool-call replay, long output, cancellation, subsequent requests and optional model discovery. It returns counters without model text or credentials and does not change the VPN connection or settings. Importing the runner makes no request; real-company execution is separate from the offline build tests.

<a id="network-constraints"></a>
## Network constraints

The data channel supports one IPv4 tunnel per process, TCP model requests, and plain UDP DNS on port 53 using up to four VPN-provided IPv4 DNS servers. It preserves HTTPS encryption between the requesting client and model endpoint, including normal client certificate verification. Stream flow control bounds queued bytes and propagates cancellation and peer closure. Windows networking remains responsible only for reaching the VPN server.

IPv6 tunnels, TAP/Ethernet mode, encrypted DNS transports, required DNSSEC, external PKI, challenge authentication, and encrypted private-key prompts are unsupported. Missing VPN DNS prevents hostname requests; literal IPv4 destinations remain usable. The helper does not fall back to the system DNS resolver or a direct model connection. Server-pushed network updates and reconnection terminate the current helper so the parent can create a fresh lwIP process. Authentication errors stop the connection; the parent owns retry policy.

Ordinary local applications cannot use the tunnel without the per-launch proxy token. The helper does not isolate mutually untrusted processes running as the same Windows user from that user's process memory. The parent owns credential storage, profile import policy and the target allowlist.

<a id="licenses-and-corresponding-source"></a>
## Licenses and corresponding source

The combined executable and original helper code use [GPL-3.0-only](LICENSE). Compiled OpenVPN files include two GPL-3.0-only headers; dual-licensed OpenVPN files select MPL-2.0, and the Unicode conversion file retains its own notice. [Packaging](scripts/package.ps1) audits the actual compiled OpenVPN include list and refuses unknown license notices. [Third-party notices](THIRD-PARTY-NOTICES.txt) identify the remaining dependencies.

Every executable distribution includes the corresponding-source ZIP and license assets in its manifest. The ZIP contains the source and build material for the linked libraries, including OpenVPN's Asio patches. It excludes private profiles, credentials and build-tool binaries. The tap-windows6 dependency supplies only its MIT-licensed public header; no TAP driver is installed, used or distributed.

<a id="further-exploration"></a>
## Further Exploration

- [Native components](../README.md)
- [Helper entry point](src/main.cpp)
- [User-space TCP/IP adapter](src/lwip_stack.hpp)
- [Offline process verification](tests/helper-protocol.test.mjs)

<a id="dev-note"></a>
## Dev Note

None.
