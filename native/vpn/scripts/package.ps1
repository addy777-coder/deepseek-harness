#Requires -Version 7.0
[CmdletBinding()]
param([string]$VsDevCmdPath, [string]$LocalDependenciesPath, [string]$Target)
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-VpnRoot
$targetInfo = Get-VpnTarget $Target
$toolchain = Get-VpnToolchain $VsDevCmdPath
Initialize-VpnSources
if (-not $LocalDependenciesPath) { $LocalDependenciesPath = Join-Path $root ".cache/dependencies/installed/$($targetInfo.Triplet)" }
$prefix = (Resolve-Path -LiteralPath $LocalDependenciesPath).Path
$build = Join-Path $root "build/$($targetInfo.Name)"
$binary = Join-Path $build $targetInfo.Binary
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build the native VPN target before packaging.' }
$pendingBuild = & $toolchain.Ninja -C $build -n dsh-vpn
if ($LASTEXITCODE -ne 0 -or $pendingBuild[-1] -ne 'ninja: no work to do.') { throw 'Rebuild dsh-vpn before packaging changed source or dependencies.' }
if ($IsWindows) {
  foreach ($path in @($root, $binary, $toolchain.VsDevCmd)) { Assert-VpnCommandPath $path }
  $dependencyReport = & $env:ComSpec /d /s /c ('"{0}" -arch=x64 -host_arch=x64 -no_logo && dumpbin /dependents "{1}"' -f $toolchain.VsDevCmd, $binary)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the executable DLL dependencies.' }
  $dependencies = @($dependencyReport | Where-Object { $_ -match '^\s+([a-zA-Z0-9_.-]+\.dll)\s*$' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Sort-Object -Unique)
  $systemDlls = @('kernel32.dll', 'ntdll.dll', 'ws2_32.dll', 'mswsock.dll', 'crypt32.dll', 'bcrypt.dll', 'iphlpapi.dll', 'fwpuclnt.dll', 'wininet.dll', 'setupapi.dll', 'advapi32.dll', 'shell32.dll', 'ole32.dll', 'rpcrt4.dll', 'wtsapi32.dll', 'user32.dll', 'gdi32.dll', 'secur32.dll', 'msvcrt.dll')
  $unexpected = @($dependencies | Where-Object { $_ -notin $systemDlls -and $_ -notmatch '^api-ms-win-' })
} elseif ($IsMacOS) {
  $dependencyReport = & otool -L $binary
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the executable dylib dependencies.' }
  $dependencies = @($dependencyReport | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+\(')[0].Trim() } | Sort-Object -Unique)
  $unexpected = @($dependencies | Where-Object { $_ -notmatch '^/usr/lib/[^/]+\.dylib$|^/System/Library/Frameworks/[^/]+\.framework/Versions/[^/]+/[^/]+$' })
} else {
  $dependencyReport = & readelf -d $binary
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the executable ELF dependencies.' }
  $dependencies = @($dependencyReport | Where-Object { $_ -match '\(NEEDED\).*\[([^\]]+)\]' } | ForEach-Object { [void]($_ -match '\(NEEDED\).*\[([^\]]+)\]'); $Matches[1] } | Sort-Object -Unique)
  $unexpected = @($dependencies | Where-Object { $_ -notmatch '^(libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|libresolv\.so\.2|libstdc\+\+\.so\.6|libgcc_s\.so\.1|ld-linux-x86-64\.so\.2)$' })
  if (@($dependencyReport | Where-Object { $_ -match '\((RPATH|RUNPATH)\)' }).Count) { throw 'The helper must not carry an ELF runtime search path.' }
}
if (-not $dependencies -or $unexpected.Count) { throw 'The helper imports an unexpected library; link third-party dependencies statically and retain only system imports.' }
$stage = Join-Path $root ('.cache/package-' + [Guid]::NewGuid().ToString('N'))
$output = Join-Path $stage $targetInfo.Name
$source = Join-Path $stage 'corresponding-source'
$material = Join-Path $source 'source-material'
$dist = Join-Path $root "dist/$($targetInfo.Name)"
New-Item -ItemType Directory -Force -Path $output, $source, (Join-Path $output 'licenses'), (Join-Path $output 'sources'), (Join-Path $material 'archives'), (Join-Path $material 'downloads'), (Join-Path $material 'ports') | Out-Null
try {
  $packagedBinary = Join-Path $output $targetInfo.Binary
  Copy-Item -LiteralPath $binary -Destination $packagedBinary
  if (-not $IsWindows) {
    & chmod 755 $packagedBinary
    if ($LASTEXITCODE -ne 0) { throw 'Could not make the packaged helper executable.' }
  }
  if ($IsMacOS) {
    & codesign --force --sign - --timestamp=none $packagedBinary
    if ($LASTEXITCODE -ne 0) { throw 'The native VPN helper ad-hoc signature failed.' }
    & codesign --verify --strict $packagedBinary
    if ($LASTEXITCODE -ne 0) { throw 'The native VPN helper signature did not verify.' }
  }
  $binaryHash = (Get-FileHash -LiteralPath $packagedBinary -Algorithm SHA256).Hash.ToLowerInvariant()
  "$binaryHash  $($targetInfo.Binary)" | Set-Content -LiteralPath (Join-Path $output ($targetInfo.Binary + '.sha256')) -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $output 'licenses/GPL-3.0.txt')
  Copy-Item -LiteralPath (Join-Path $root 'THIRD-PARTY-NOTICES.txt') -Destination (Join-Path $output 'licenses/THIRD-PARTY-NOTICES.txt')
  $openvpn = Join-Path $root '.cache/sources/openvpn3'
  Copy-Item -LiteralPath (Join-Path $openvpn 'LICENSE.md') -Destination (Join-Path $output 'licenses/OpenVPN3-NOTICE.txt')
  foreach ($license in Get-ChildItem -LiteralPath (Join-Path $openvpn 'LICENSES') -File) {
    Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $output ('licenses/OpenVPN3-' + $license.Name))
  }
  $unicode = Get-Content -LiteralPath (Join-Path $openvpn 'openvpn/common/unicode-impl.hpp') -Raw
  $unicodeNotice = $unicode.Substring(0, $unicode.IndexOf('#ifndef')).TrimEnd()
  $unicodeNotice | Set-Content -LiteralPath (Join-Path $output 'licenses/Unicode-CVTUTF.txt') -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $root '.cache/sources/lwip/COPYING') -Destination (Join-Path $output 'licenses/lwIP.txt')
  $libraryNames = @('asio', 'fmt', 'jsoncpp', 'lz4', 'openssl', 'xxhash')
  if ($IsWindows) { $libraryNames += 'tap-windows6' }
  foreach ($name in $libraryNames) {
    Copy-Item -LiteralPath (Join-Path $prefix "share/$name/copyright") -Destination (Join-Path $output "licenses/$name.txt")
  }
  $pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
  $dependencyLines = & $toolchain.Ninja -C $build -t deps
  if ($LASTEXITCODE -ne 0) { throw 'Ninja could not report compiled includes for the license audit.' }
  $compiled = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $selectedObject = $false
  foreach ($line in $dependencyLines) {
    if ($line -match '^(.+): #deps ') { $selectedObject = $Matches[1].Replace('\', '/').StartsWith('CMakeFiles/dsh-vpn.dir/'); continue }
    if (-not $selectedObject -or $line -notmatch '^    (.+)$') { continue }
    $path = [System.IO.Path]::GetFullPath($Matches[1], $build)
    if ($path.StartsWith($openvpn + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      [void]$compiled.Add([System.IO.Path]::GetRelativePath($openvpn, $path).Replace('\', '/'))
    }
  }
  [void]$compiled.Add('openvpn/crypto/data_epoch.cpp')
  $gplFiles = @('openvpn/crypto/tls_crypt_v2.hpp', 'openvpn/openssl/util/pem.hpp')
  $requiredFiles = @('client/ovpncli.cpp') + $gplFiles
  if ($IsWindows) { $requiredFiles += 'openvpn/common/unicode-impl.hpp' }
  foreach ($required in $requiredFiles) {
    if (-not $compiled.Contains($required)) { throw "Compiled license audit is missing $required." }
  }
  $audit = @($compiled | Sort-Object | ForEach-Object {
    $relative = $_
    $path = Join-Path $openvpn $relative
    $content = Get-Content -LiteralPath $path -Raw
    $license = if ($content -match 'SPDX-License-Identifier: MPL-2\.0 OR AGPL-3\.0-only WITH openvpn3-openssl-exception') { 'MPL-2.0' }
      elseif ($relative -in $gplFiles -and $content -match 'GNU General Public License Version 3') { 'GPL-3.0-only' }
      elseif ($relative -eq 'openvpn/common/unicode-impl.hpp' -and $content -match 'Copyright 2001-2004 Unicode, Inc\.') { 'LicenseRef-Unicode-CVTUTF-2004' }
      else { throw "Compiled OpenVPN source requires a license review: $relative" }
    [ordered]@{ path = $relative; license = $license; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  [ordered]@{ formatVersion = 1; openvpnRevision = $pins.openvpn3.revision; executableLicense = 'GPL-3.0-only'; files = $audit } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'licenses/openvpn-compiled-files.json') -Encoding utf8
  foreach ($name in @('src', 'tests', 'scripts', 'deps')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination $source -Recurse }
  foreach ($name in @('.gitignore', 'CMakeLists.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'README.md', 'README.zh.md', 'README.i18n.yaml')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $source
  }
  $restored = Test-Path -LiteralPath (Join-Path $root '.cache/source-provenance.json') -PathType Leaf
  foreach ($name in @('openvpn3', 'lwip', 'vcpkg')) {
    $archive = Join-Path $material "archives/$name.tar"
    if ($restored) { Copy-Item -LiteralPath (Join-Path $root "source-material/archives/$name.tar") -Destination $archive }
    else {
      & git -C (Join-Path $root ".cache/sources/$name") archive --format=tar "--output=$archive" $pins.$name.revision
      if ($LASTEXITCODE -ne 0) { throw "Could not archive the pinned $name source." }
    }
  }
  $portTrees = Get-Content -LiteralPath (Join-Path $root 'deps/port-trees.json') -Raw | ConvertFrom-Json
  foreach ($port in $portTrees.PSObject.Properties) {
    if ($port.Name -eq 'tap-windows6' -and -not $IsWindows) { continue }
    $destination = Join-Path $material ('ports/' + $port.Name)
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    if ($restored) { Copy-Item -Path (Join-Path $root ('.cache/source-ports/' + $port.Name + '/*')) -Destination $destination -Recurse }
    else {
      $portArchive = Join-Path $stage ($port.Name + '.tar')
      $registryGit = Join-Path $root '.cache/dependencies/registries/git'
      & git -C $registryGit archive --format=tar "--output=$portArchive" $port.Value
      if ($LASTEXITCODE -ne 0) { throw "Could not archive the pinned $($port.Name) port." }
      & tar -xf $portArchive -C $destination
      if ($LASTEXITCODE -ne 0) { throw 'Could not extract an archived port.' }
    }
  }
  Copy-Item -LiteralPath (Join-Path $openvpn 'deps/vcpkg-ports/asio') -Destination (Join-Path $material 'ports') -Recurse
  $archives = Get-Content -LiteralPath (Join-Path $root 'deps/source-archives.json') -Raw | ConvertFrom-Json
  foreach ($archive in $archives) {
    if ($archive.name.StartsWith('OpenVPN-tap-windows6-') -and -not $IsWindows) { continue }
    $path = Join-Path $root ('.cache/dependencies/downloads/' + $archive.name)
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) {
      throw "Source archive does not match its pin: $($archive.name)"
    }
    Copy-Item -LiteralPath $path -Destination (Join-Path $material 'downloads')
  }
  $sourceFiles = @(Get-ChildItem -LiteralPath $material -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = [System.IO.Path]::GetRelativePath($material, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  [ordered]@{ revisions = @{ openvpn3 = $pins.openvpn3.revision; lwip = $pins.lwip.revision; vcpkg = $pins.vcpkg.revision }; files = $sourceFiles } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $material 'index.json') -Encoding utf8
  [System.IO.Compression.ZipFile]::CreateFromDirectory($source, (Join-Path $output 'sources/dsh-vpn-corresponding-source.zip'), [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $assets = @(Get-ChildItem -LiteralPath $output -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = [System.IO.Path]::GetRelativePath($output, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $_.Length }
  })
  [ordered]@{ formatVersion = 1; platform = $targetInfo.Platform; arch = $targetInfo.Arch; binary = $targetInfo.Binary; license = 'GPL-3.0-only'; source = 'sources/dsh-vpn-corresponding-source.zip'; dependencies = $dependencies; assets = $assets } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding utf8
  if ([System.IO.Path]::GetFullPath($dist) -ne [System.IO.Path]::GetFullPath((Join-Path $root "dist/$($targetInfo.Name)"))) { throw 'Invalid distribution cleanup target.' }
  if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path $dist -Parent) | Out-Null
  Move-Item -LiteralPath $output -Destination $dist
  Write-Output "Packaged $($targetInfo.Binary) and complete corresponding source at $dist"
} finally {
  $resolvedStage = [System.IO.Path]::GetFullPath($stage)
  $cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $root '.cache')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedStage.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedStage -Leaf) -notmatch '^package-[a-f0-9]{32}$') { throw 'Invalid package cleanup target.' }
  if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
