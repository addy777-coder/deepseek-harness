#Requires -Version 7.0
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-VpnRoot
$material = Join-Path $root 'source-material'
$index = Get-Content -LiteralPath (Join-Path $material 'index.json') -Raw | ConvertFrom-Json
$pins = Get-Content -LiteralPath (Join-Path $root 'deps/pins.json') -Raw | ConvertFrom-Json
foreach ($name in @('openvpn3', 'lwip', 'vcpkg')) {
  if ($index.revisions.$name -ne $pins.$name.revision) { throw 'The corresponding source contains a different upstream revision.' }
}
foreach ($file in $index.files) {
  $path = [System.IO.Path]::GetFullPath((Join-Path $material $file.path))
  if (-not $path.StartsWith($material + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid source material path.' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'The corresponding source failed integrity verification.' }
}
$sources = Join-Path $root '.cache/sources'
$ports = Join-Path $root '.cache/source-ports'
if ((Test-Path -LiteralPath $sources) -or (Test-Path -LiteralPath $ports)) {
  throw 'Restore into a fresh extraction of the corresponding source archive.'
}
foreach ($name in @('openvpn3', 'lwip', 'vcpkg')) {
  $destination = Join-Path $sources $name
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $archive = Join-Path $material "archives/$name.tar"
  $entries = & tar -tf $archive
  if ($LASTEXITCODE -ne 0 -or @($entries | Where-Object { $_ -match '(^[/\\]|^[a-zA-Z]:|(^|[/\\])\.\.([/\\]|$))' }).Count) { throw 'An upstream source archive contains an invalid path.' }
  & tar -xf $archive -C $destination
  if ($LASTEXITCODE -ne 0) { throw "Could not extract $name source." }
}
Copy-Item -LiteralPath (Join-Path $material 'ports') -Destination $ports -Recurse
$downloads = Join-Path $root '.cache/dependencies/downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $material 'downloads') -File) { Copy-Item -LiteralPath $file.FullName -Destination $downloads }
$files = @(Get-ChildItem -LiteralPath $sources, $ports -File -Recurse | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = [System.IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
[ordered]@{ revisions = $index.revisions; files = $files } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root '.cache/source-provenance.json') -Encoding utf8
Initialize-VpnSources
Write-Output 'Restored verified upstream sources, port patches and dependency source archives. Run scripts/build.ps1 with Visual Studio C++ Build Tools installed.'
