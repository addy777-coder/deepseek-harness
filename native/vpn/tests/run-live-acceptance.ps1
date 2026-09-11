#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$ReportPath,
  [ValidateRange(60, 7200)][int]$RunTimeoutSeconds = 1800,
  [ValidateRange(1000, 60000)][int]$ShutdownGraceMs = 10000
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'network-snapshot.ps1')

function Get-VpnLiveHostSnapshot {
  $snapshot = Get-VpnNetworkSnapshot
  $json = $snapshot.network
  $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
  [pscustomobject]@{
    digest = $digest
    externalOpenvpnActive = $snapshot.externalOpenvpnActive
    helperCount = $snapshot.helperCount
  }
}

function Start-VpnLiveFixture([string]$RepositoryPath, [string]$FixtureReportPath, [int]$TimeoutSeconds, [int]$GraceMs) {
  $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $node
  $start.WorkingDirectory = $RepositoryPath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @('--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--patch', 'native/vpn/tests/live-acceptance.patch.yml')) {
    $start.ArgumentList.Add($argument)
  }
  $start.Environment['DSH_VPN_LIVE_REPORT_PATH'] = $FixtureReportPath
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $start
  $started = $false
  try {
    $started = $child.Start()
    if (-not $started) { throw 'VPN_LIVE_LAUNCH_FAILED' }
    # Launcher output can contain unrelated plugin diagnostics; only the fixed-field reports leave memory.
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) { throw 'VPN_LIVE_RUN_TIMEOUT' }
    $child.WaitForExit()
    [void]$stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    return $child.ExitCode
  } finally {
    if ($started -and -not $child.HasExited) {
      $child.Kill($true)
      if (-not $child.WaitForExit($GraceMs)) { throw 'VPN_LIVE_LAUNCHER_SHUTDOWN_FAILED' }
    }
    $child.Dispose()
  }
}

function Invoke-VpnLiveAcceptance([string]$OutputPath, [int]$TimeoutSeconds, [int]$GraceMs) {
  $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
  if (-not $OutputPath) {
    $OutputPath = Join-Path $repository ('native/vpn/.cache/live-acceptance-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N') + '.json')
  }
  $output = [IO.Path]::GetFullPath($OutputPath)
  $fixturePath = [IO.Path]::ChangeExtension($output, '.fixture.json')
  $report = [ordered]@{
    formatVersion = 1
    startedAt = [DateTime]::UtcNow.ToString('o')
    finishedAt = $null
    passed = $false
    failureCode = $null
    preLaunchBaseline = $false
    fixtureExitCode = $null
    fixturePassed = $false
    systemNetworkUnchanged = $null
    externalOpenvpnAbsent = $null
    ownedHelpersExited = $null
    fixtureReportPath = $fixturePath
  }
  $before = $null
  $reportFile = $null
  try {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
    $reportFile = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    if ([IO.File]::Exists($fixturePath)) { throw 'VPN_LIVE_REPORT_EXISTS' }
    $before = Get-VpnLiveHostSnapshot
    $report.preLaunchBaseline = $true
    $report.externalOpenvpnAbsent = -not $before.externalOpenvpnActive
    $report.ownedHelpersExited = $before.helperCount -eq 0
    if ($before.externalOpenvpnActive -or $before.helperCount -ne 0) { throw 'VPN_LIVE_COMPETING_VPN' }
    $report.fixtureExitCode = Start-VpnLiveFixture $repository $fixturePath $TimeoutSeconds $GraceMs
    if (-not [IO.File]::Exists($fixturePath)) { throw 'VPN_LIVE_FIXTURE_REPORT_MISSING' }
    $fixture = [IO.File]::ReadAllText($fixturePath) | ConvertFrom-Json -AsHashtable
    if ($fixture.formatVersion -ne 1 -or $fixture.passed -isnot [bool]) { throw 'VPN_LIVE_FIXTURE_REPORT_INVALID' }
    $report.fixturePassed = $fixture.passed
    if ($report.fixtureExitCode -ne 0 -or -not $fixture.passed) {
      if ($fixture.failureCode -is [string] -and $fixture.failureCode -cmatch '^VPN_[A-Z0-9_]{1,100}$') { throw $fixture.failureCode }
      throw 'VPN_LIVE_FIXTURE_FAILED'
    }
    $report.passed = $true
  } catch {
    $message = $_.Exception.Message
    $report.failureCode = if ($message -cmatch '^VPN_[A-Z0-9_]{1,100}$') { $message } else { 'VPN_LIVE_HOST_CHECK_FAILED' }
  } finally {
    if ($before) {
      try {
        $after = Get-VpnLiveHostSnapshot
        $report.systemNetworkUnchanged = $before.digest -ceq $after.digest
        $report.externalOpenvpnAbsent = $report.externalOpenvpnAbsent -and -not $after.externalOpenvpnActive
        $report.ownedHelpersExited = $after.helperCount -eq 0
        if (-not $report.systemNetworkUnchanged -or -not $report.externalOpenvpnAbsent -or -not $report.ownedHelpersExited) {
          $report.passed = $false
          if (-not $report.failureCode) { $report.failureCode = 'VPN_LIVE_HOST_VERIFICATION_FAILED' }
        }
      } catch {
        $report.passed = $false
        if (-not $report.failureCode) { $report.failureCode = 'VPN_LIVE_HOST_SNAPSHOT_FAILED' }
      }
    }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    if ($reportFile) {
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 5) + "`n")
        $reportFile.Write($bytes, 0, $bytes.Length)
      } catch { $report.passed = $false; $report.failureCode = 'VPN_LIVE_REPORT_WRITE_FAILED' }
      finally { $reportFile.Dispose() }
    }
  }
  [pscustomobject]@{ event = 'vpn-live-host-acceptance'; passed = $report.passed; reportPath = $output; failureCode = $report.failureCode }
}

if ($MyInvocation.InvocationName -ne '.') {
  $result = Invoke-VpnLiveAcceptance $ReportPath $RunTimeoutSeconds $ShutdownGraceMs
  $result | ConvertTo-Json -Compress
  if ($result.passed) { exit 0 }
  exit 1
}
