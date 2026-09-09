#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'run-live-acceptance.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-vpn-host-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$script:launches = 0
$script:snapshots = [Collections.Generic.Queue[object]]::new()
$script:fixturePassed = $true
$script:fixtureCode = 0

function Assert-Equal($Actual, $Expected, [string]$Name) {
  if ($Actual -cne $Expected) { throw "Offline assertion failed: $Name" }
}
function Get-VpnLiveHostSnapshot {
  if ($script:snapshots.Count -eq 0) { throw 'Unexpected offline snapshot' }
  $script:snapshots.Dequeue()
}
function Start-VpnLiveFixture([string]$RepositoryPath, [string]$FixtureReportPath, [int]$TimeoutSeconds, [int]$GraceMs) {
  $script:launches++
  if (-not (Test-Path -LiteralPath (Join-Path $RepositoryPath 'apps/cli/src/bin.ts'))) { throw 'Launcher not found' }
  if ($TimeoutSeconds -ne 60 -or $GraceMs -ne 1000) { throw 'Fixture limits not forwarded' }
  @{ formatVersion = 1; passed = $script:fixturePassed; failureCode = if ($script:fixturePassed) { $null } else { 'VPN_LIVE_TOOL_CALL_MISSING' } } |
    ConvertTo-Json | Set-Content -LiteralPath $FixtureReportPath -Encoding utf8
  return $script:fixtureCode
}
function Add-Snapshot([string]$Digest = 'unchanged', [bool]$External = $false, [int]$Helpers = 0) {
  $script:snapshots.Enqueue([pscustomobject]@{ digest = $Digest; externalOpenvpnActive = $External; helperCount = $Helpers })
}
function Read-Report([string]$Name) {
  $path = Join-Path $fixtureRoot ($Name + '.json')
  $result = Invoke-VpnLiveAcceptance $path 60 1000
  $json = Get-Content -LiteralPath $path -Raw
  if ($json.Contains('secret') -or $json.Contains('unchanged')) { throw 'Report exposed raw snapshot or credential text' }
  [pscustomobject]@{ Result = $result; Report = $json | ConvertFrom-Json }
}

try {
  Add-Snapshot; Add-Snapshot
  $pass = Read-Report 'success'
  Assert-Equal $pass.Result.passed $true 'clean run passes'
  Assert-Equal $pass.Report.preLaunchBaseline $true 'baseline before fixture'
  Assert-Equal $pass.Report.systemNetworkUnchanged $true 'system unchanged'
  Assert-Equal $script:launches 1 'one launcher invocation'

  Add-Snapshot -External $true; Add-Snapshot -External $true
  $external = Read-Report 'external'
  Assert-Equal $external.Result.failureCode 'VPN_LIVE_COMPETING_VPN' 'external VPN refusal'
  Assert-Equal $script:launches 1 'external VPN prevents launch'

  Add-Snapshot -Helpers 1; Add-Snapshot -Helpers 1
  $competing = Read-Report 'competing-helper'
  Assert-Equal $competing.Result.failureCode 'VPN_LIVE_COMPETING_VPN' 'existing helper refusal'
  Assert-Equal $script:launches 1 'existing helper prevents launch'

  Add-Snapshot; Add-Snapshot -Digest 'changed'
  $changed = Read-Report 'network-change'
  Assert-Equal $changed.Result.passed $false 'network changes fail despite fixture success'
  Assert-Equal $changed.Report.systemNetworkUnchanged $false 'changed network recorded'

  Add-Snapshot; Add-Snapshot -Helpers 1
  $leftover = Read-Report 'leftover'
  Assert-Equal $leftover.Report.ownedHelpersExited $false 'remaining helper recorded'
  Assert-Equal $leftover.Result.passed $false 'remaining helper fails'

  $script:fixturePassed = $false
  $script:fixtureCode = 1
  Add-Snapshot; Add-Snapshot
  $failed = Read-Report 'fixture-failure'
  Assert-Equal $failed.Result.failureCode 'VPN_LIVE_TOOL_CALL_MISSING' 'fixed fixture failure retained'
  Assert-Equal $failed.Report.systemNetworkUnchanged $true 'post-failure snapshot still runs'

  $existing = Join-Path $fixtureRoot 'success.json'
  $original = [IO.File]::ReadAllText($existing)
  $repeat = Invoke-VpnLiveAcceptance $existing 60 1000
  Assert-Equal $repeat.passed $false 'existing report rejected'
  Assert-Equal ([IO.File]::ReadAllText($existing)) $original 'existing report preserved'
  Write-Output 'PASS 7 offline live-host acceptance cases; no native process or network connection started.'
} finally {
  $resolved = [IO.Path]::GetFullPath($fixtureRoot)
  if ([IO.Path]::GetDirectoryName($resolved) -cne [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetTempPath()) -or
    -not [IO.Path]::GetFileName($resolved).StartsWith('dsh-vpn-host-test-', [StringComparison]::Ordinal)) {
    throw 'Refusing to remove an unexpected offline fixture path.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
