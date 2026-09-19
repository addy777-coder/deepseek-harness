#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

function Get-VpnRoot {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-VpnApplicationPath([string]$Name) {
  (Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}

function Get-VpnTarget([string]$Name) {
  $platform = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'darwin' } elseif ($IsLinux) { 'linux' } else { throw 'Unsupported native VPN host.' }
  $arch = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
  $hostTarget = "$platform-$arch"
  if (-not $Name) { $Name = $hostTarget }
  if ($Name -notin @('windows-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64')) { throw "Unsupported native VPN target: $Name" }
  if ($Name -ne $hostTarget) { throw "Build $Name on a matching native host; this process runs on $hostTarget." }
  $system = if ($platform -eq 'darwin') { 'osx' } else { $platform }
  [pscustomobject]@{
    Name = $Name; Platform = $platform; Arch = $arch; Triplet = "$arch-$system-dsh-vpn"; HostTriplet = "$arch-$system"
    Binary = if ($IsWindows) { 'dsh-vpn.exe' } else { 'dsh-vpn' }
    Crt = if ($IsWindows) { 'static' } else { 'system' }
  }
}

function Get-VpnToolchain([string]$VsDevCmdPath) {
  if (-not $IsWindows) {
    if ($VsDevCmdPath) { throw 'VsDevCmdPath is supported only on Windows.' }
    $root = Get-VpnRoot
    $pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
    return [pscustomobject]@{
      VsDevCmd = $null
      CMake = Get-VpnApplicationPath cmake
      CTest = Get-VpnApplicationPath ctest
      Ninja = Get-VpnApplicationPath ninja
      Vcpkg = Join-Path $root ('.cache/tools/vcpkg-' + $pins.vcpkg.revision + '/vcpkg')
    }
  }
  if (-not $VsDevCmdPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
      throw 'Pass -VsDevCmdPath for the installed Visual Studio C++ Build Tools.'
    }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio x64 C++ Build Tools were not found.' }
    $VsDevCmdPath = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
  }
  $resolved = (Resolve-Path -LiteralPath $VsDevCmdPath).Path
  $vsRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $resolved -Parent) '../..'))
  [pscustomobject]@{
    VsDevCmd = $resolved
    CMake = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
    CTest = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/ctest.exe'
    Ninja = Join-Path $vsRoot 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe'
    Vcpkg = Join-Path $vsRoot 'VC/vcpkg/vcpkg.exe'
  }
}

function Initialize-VpnToolchain($Toolchain) {
  if (Test-Path -LiteralPath $Toolchain.Vcpkg -PathType Leaf) { return }
  if ($IsWindows) { throw 'Install the Visual Studio vcpkg component.' }
  $root = Get-VpnRoot
  $source = Join-Path $root '.cache/sources/vcpkg'
  $tools = Split-Path $Toolchain.Vcpkg -Parent
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  # Bootstrap writes its executable and downloads outside the verified source tree.
  foreach ($name in @('.vcpkg-root', 'bootstrap-vcpkg.sh', 'scripts')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $tools -Recurse -Force
  }
  & sh (Join-Path $tools 'bootstrap-vcpkg.sh') -disableMetrics
  if ($LASTEXITCODE -ne 0) { throw 'The pinned vcpkg tool did not bootstrap.' }
}

function Assert-VpnCommandPath([string]$Path) {
  if ($Path -match '["%\r\n]') { throw 'A build path contains unsupported command characters.' }
}

function Initialize-VpnSources {
  $root = Get-VpnRoot
  $pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
  $sourceRoot = Join-Path $root '.cache/sources'
  $sourceRecord = Join-Path $root '.cache/source-provenance.json'
  if (Test-Path -LiteralPath $sourceRecord -PathType Leaf) {
    $record = Get-Content -LiteralPath $sourceRecord -Raw | ConvertFrom-Json
    foreach ($name in @('openvpn3', 'lwip', 'vcpkg')) {
      if ($record.revisions.$name -ne $pins.$name.revision) { throw 'Restored sources do not match deps/pins.json.' }
    }
    $actual = @(Get-ChildItem -LiteralPath $sourceRoot, (Join-Path $root '.cache/source-ports') -File -Recurse)
    if ($actual.Count -ne $record.files.Count) { throw 'Restored sources contain missing or extra files.' }
    foreach ($file in $record.files) {
      $path = [System.IO.Path]::GetFullPath((Join-Path $root $file.path))
      if (-not $path.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Restored source record contains an invalid path.'
      }
      if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
        throw "Restored source was changed: $($file.path)"
      }
    }
    return
  }
  New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
  foreach ($name in @('openvpn3', 'lwip', 'vcpkg')) {
    $pin = $pins.$name
    $path = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
      if (Test-Path -LiteralPath $path) { throw "Source cache is not a Git checkout: $path" }
      & git init $path
      if ($LASTEXITCODE -ne 0) { throw "Could not initialize $name source cache." }
      & git -C $path remote add origin $pin.repository
      if ($LASTEXITCODE -ne 0) { throw "Could not configure $name source cache." }
      & git -C $path fetch --depth=1 origin $pin.revision
      if ($LASTEXITCODE -ne 0) { throw "Could not fetch the pinned $name revision." }
      & git -C $path checkout --detach FETCH_HEAD
      if ($LASTEXITCODE -ne 0) { throw "Could not check out the pinned $name revision." }
    }
    $revision = & git -C $path rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $revision -ne $pin.revision) { throw "The $name source cache does not match deps/pins.json." }
    $changes = & git -C $path status --porcelain --untracked-files=all --ignored=matching
    if ($LASTEXITCODE -ne 0 -or $changes) { throw "The $name source cache contains modified or extra files." }
  }
}
