#Requires -Version 7.0
[CmdletBinding()]
param([string]$VsDevCmdPath, [string]$Target)
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-VpnRoot
$targetInfo = Get-VpnTarget $Target
$toolchain = Get-VpnToolchain $VsDevCmdPath
Initialize-VpnSources
Initialize-VpnToolchain $toolchain
$deps = Join-Path $root '.cache/dependencies'
$registry = Join-Path $root '.cache/sources/vcpkg'
$directories = @($deps, (Join-Path $deps 'registries'), (Join-Path $deps 'binary-cache'), (Join-Path $deps 'downloads'))
New-Item -ItemType Directory -Force -Path $directories | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'deps/vcpkg.json') -Destination (Join-Path $deps 'vcpkg.json')
$pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
$restoredSources = Test-Path -LiteralPath (Join-Path $root '.cache/source-provenance.json') -PathType Leaf
$configuration = if ($restoredSources) { @{ 'default-registry' = $null } }
  else { @{ 'default-registry' = @{ kind = 'git'; repository = $registry; baseline = $pins.vcpkg.revision } } }
$ports = if ($restoredSources) { Join-Path $root '.cache/source-ports' }
  else { Join-Path $root '.cache/sources/openvpn3/deps/vcpkg-ports' }
$configuration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $deps 'vcpkg-configuration.json') -Encoding utf8
$savedEnvironment = @{}
foreach ($name in @('PATH', 'VCPKG_DISABLE_METRICS', 'X_VCPKG_REGISTRIES_CACHE', 'VCPKG_DEFAULT_BINARY_CACHE', 'VCPKG_MAX_CONCURRENCY')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
  $env:PATH = (Split-Path $toolchain.CMake -Parent) + [IO.Path]::PathSeparator + (Split-Path $toolchain.Ninja -Parent) + [IO.Path]::PathSeparator + $env:PATH
  $env:VCPKG_DISABLE_METRICS = '1'
  $env:X_VCPKG_REGISTRIES_CACHE = Join-Path $deps 'registries'
  $env:VCPKG_DEFAULT_BINARY_CACHE = Join-Path $deps 'binary-cache'
  $env:VCPKG_MAX_CONCURRENCY = '8'
  & $toolchain.Vcpkg install "--vcpkg-root=$registry" "--triplet=$($targetInfo.Triplet)" "--host-triplet=$($targetInfo.HostTriplet)" `
    "--x-manifest-root=$deps" "--x-install-root=$deps/installed" "--x-buildtrees-root=$deps/buildtrees" `
    "--x-packages-root=$deps/packages" "--downloads-root=$deps/downloads" `
    "--overlay-triplets=$root/deps/triplets" "--overlay-ports=$ports"
  if ($LASTEXITCODE -ne 0) { throw 'The native VPN dependencies did not build.' }
  $provenance = @{
    triplet = $targetInfo.Triplet
    crt = $targetInfo.Crt
    registryRevision = $pins.vcpkg.revision
    manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'deps/vcpkg.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    tripletSha256 = (Get-FileHash -LiteralPath (Join-Path $root "deps/triplets/$($targetInfo.Triplet).cmake") -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $provenance | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $deps "installed/$($targetInfo.Triplet)/dsh-vpn-dependencies.json") -Encoding utf8
} finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
