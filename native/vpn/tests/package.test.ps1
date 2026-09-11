#Requires -Version 7.0
[CmdletBinding()]
param([string]$Target)
. (Join-Path $PSScriptRoot '../scripts/common.ps1')
$root = Get-VpnRoot
$targetInfo = Get-VpnTarget $Target
$distribution = Join-Path $root "dist/$($targetInfo.Name)"
$manifest = Get-Content -LiteralPath (Join-Path $distribution 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.formatVersion -ne 1 -or $manifest.license -ne 'GPL-3.0-only') { throw 'The release manifest has unexpected metadata.' }
if ($manifest.platform -ne $targetInfo.Platform -or $manifest.arch -ne $targetInfo.Arch -or $manifest.binary -ne $targetInfo.Binary) { throw 'The release manifest targets a different host.' }
if (-not $IsWindows) {
  & test -x (Join-Path $distribution $manifest.binary)
  if ($LASTEXITCODE -ne 0) { throw 'The distributed helper is not executable.' }
}
if ($IsMacOS) {
  & codesign --verify --strict (Join-Path $distribution $manifest.binary)
  if ($LASTEXITCODE -ne 0) { throw 'The distributed helper signature did not verify.' }
}
$files = @(Get-ChildItem -LiteralPath $distribution -File -Recurse)
if ($files.Count -ne $manifest.assets.Count + 1) { throw 'The release manifest does not enumerate every asset.' }
foreach ($asset in $manifest.assets) {
  $path = [System.IO.Path]::GetFullPath((Join-Path $distribution $asset.path))
  if (-not $path.StartsWith($distribution + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'An asset escapes its release directory.' }
  if ((Get-Item -LiteralPath $path).Length -ne $asset.size -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'An asset does not match the release manifest.' }
}
$source = Join-Path $distribution $manifest.source
$archive = [System.IO.Compression.ZipFile]::OpenRead($source)
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -match '(^|/)(\.git|\.cache|\.env|build|dist)(/|$)' -or $entry.FullName -match '\.(exe|dll|ovpn|key|p12|pfx)$') {
      throw 'The corresponding source contains a build artifact or private-profile filename.'
    }
  }
} finally { $archive.Dispose() }
$smoke = Join-Path $root ('.cache/source-smoke-' + [Guid]::NewGuid().ToString('N'))
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($source, $smoke)
  & pwsh -NoProfile -File (Join-Path $smoke 'scripts/restore-sources.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'The corresponding source did not restore successfully.' }
  $changed = Join-Path $smoke '.cache/sources/openvpn3/client/ovpncli.hpp'
  Add-Content -LiteralPath $changed -Value '// changed source fixture' -Encoding utf8
  & {
    param($RestoredRoot)
    . (Join-Path $RestoredRoot 'scripts/common.ps1')
    try { Initialize-VpnSources }
    catch {
      if ($_.Exception.Message -like 'Restored source was changed:*') { return }
      throw
    }
    throw 'Source verification accepted a changed restored dependency.'
  } $smoke
  Write-Output 'PASS package integrity, source-only ZIP, source restoration and changed-source rejection'
} finally {
  $resolved = [System.IO.Path]::GetFullPath($smoke)
  $cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $root '.cache')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notmatch '^source-smoke-[a-f0-9]{32}$') { throw 'Invalid source smoke cleanup target.' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
