#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$VsDevCmdPath,
  [string]$LocalDependenciesPath,
  [string]$Target,
  [switch]$Fresh,
  [switch]$SkipTests,
  [switch]$SkipPackage
)
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-VpnRoot
$targetInfo = Get-VpnTarget $Target
$toolchain = Get-VpnToolchain $VsDevCmdPath
Initialize-VpnSources
if (-not $LocalDependenciesPath) {
  & (Join-Path $PSScriptRoot 'prepare-deps.ps1') -VsDevCmdPath $toolchain.VsDevCmd -Target $targetInfo.Name
  $LocalDependenciesPath = Join-Path $root ".cache/dependencies/installed/$($targetInfo.Triplet)"
}
$prefix = (Resolve-Path -LiteralPath $LocalDependenciesPath).Path
$dependencyInputs = Get-Content -LiteralPath (Join-Path $prefix 'dsh-vpn-dependencies.json') -Raw | ConvertFrom-Json
$pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
if ($dependencyInputs.triplet -ne $targetInfo.Triplet -or $dependencyInputs.crt -ne $targetInfo.Crt `
    -or $dependencyInputs.registryRevision -ne $pins.vcpkg.revision `
    -or $dependencyInputs.manifestSha256 -ne (Get-FileHash -LiteralPath (Join-Path $root 'deps/vcpkg.json') -Algorithm SHA256).Hash.ToLowerInvariant() `
    -or $dependencyInputs.tripletSha256 -ne (Get-FileHash -LiteralPath (Join-Path $root "deps/triplets/$($targetInfo.Triplet).cmake") -Algorithm SHA256).Hash.ToLowerInvariant()) {
  throw 'LocalDependenciesPath does not contain the pinned dependencies for this native VPN target.'
}
$build = Join-Path $root "build/$($targetInfo.Name)"
$testing = if ($SkipTests) { 'OFF' } else { 'ON' }
$freshOption = if ($Fresh) { '--fresh ' } else { '' }
if ($IsWindows) {
  foreach ($path in @($root, $build, $prefix, $toolchain.VsDevCmd)) { Assert-VpnCommandPath $path }
  # CMake and Ninja must decode localized MSVC include prefixes with the same code page.
  $command = 'chcp 65001 >nul && "{0}" -arch=x64 -host_arch=x64 -no_logo && cmake {5}-S "{1}" -B "{2}" -G Ninja "-DCMAKE_PREFIX_PATH={3}" "-DOPENSSL_INCLUDE_DIR={3}/include" "-DOPENSSL_SSL_LIBRARY={3}/lib/libssl.lib" "-DOPENSSL_CRYPTO_LIBRARY={3}/lib/libcrypto.lib" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING={4} && cmake --build "{2}" --parallel 2' -f $toolchain.VsDevCmd, $root, $build, $prefix, $testing, $freshOption
  & $env:ComSpec /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw 'The native VPN executable did not build.' }
} else {
  $configure = @('-S', $root, '-B', $build, '-G', 'Ninja', "-DCMAKE_PREFIX_PATH=$prefix", "-DOPENSSL_ROOT_DIR=$prefix", '-DCMAKE_BUILD_TYPE=Release', "-DBUILD_TESTING=$testing")
  if ($Fresh) { $configure += '--fresh' }
  if ($IsMacOS) { $configure += @('-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0', "-DCMAKE_OSX_ARCHITECTURES=$($targetInfo.Arch -replace '^x64$', 'x86_64')") }
  & $toolchain.CMake @configure
  if ($LASTEXITCODE -ne 0) { throw 'The native VPN CMake configuration failed.' }
  & $toolchain.CMake --build $build --parallel 2
  if ($LASTEXITCODE -ne 0) { throw 'The native VPN executable did not build.' }
}
if (-not $SkipTests) {
  & $toolchain.CTest --test-dir $build --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw 'Native VPN CTest checks failed.' }
  & node (Join-Path $root 'tests/helper-protocol.test.mjs') (Join-Path $build $targetInfo.Binary)
  if ($LASTEXITCODE -ne 0) { throw 'Native VPN helper protocol checks failed.' }
}
if (-not $SkipPackage) {
  & (Join-Path $PSScriptRoot 'package.ps1') -LocalDependenciesPath $prefix -VsDevCmdPath $toolchain.VsDevCmd -Target $targetInfo.Name
  if (-not $SkipTests) { & (Join-Path $root 'tests/package.test.ps1') -Target $targetInfo.Name }
}
