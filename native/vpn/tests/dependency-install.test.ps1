#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/dependency-install.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-vpn-download-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$fixture = Join-Path $temporary 'vcpkg-fixture.ps1'
$executable = (Get-Process -Id $PID).Path
$script:waits = [Collections.Generic.List[int]]::new()
$wait = { param([int]$Seconds) $script:waits.Add($Seconds) }

function Assert-Equal($Actual, $Expected, [string]$Name) {
  if ($Actual -cne $Expected) { throw "Dependency retry assertion failed: $Name ($Actual != $Expected)" }
}

try {
  @'
param([string]$State, [string]$Scenario)
$attempt = if (Test-Path -LiteralPath $State) { 1 + [int](Get-Content -LiteralPath $State -Raw) } else { 1 }
Set-Content -LiteralPath $State -Value $attempt -NoNewline
if ($Scenario -eq 'success' -or ($Scenario -in @('recover', 'recover-http') -and $attempt -eq 2)) { exit 0 }
if ($Scenario -eq 'compile') { Write-Output 'error: C++ compilation failed'; exit 1 }
if ($Scenario -eq 'partial-transfer') { Write-Output 'error: curl: (56) Recv failure'; exit 1 }
if ($Scenario -eq 'not-found') { Write-Output 'error: curl: (22) The requested URL returned error: 404' }
elseif ($Scenario -eq 'proxy-denied') { Write-Output 'error: curl: (56) The requested URL returned error: 403' }
elseif ($Scenario -eq 'recover-http') { Write-Output 'error: curl: (22) The requested URL returned error: 504' }
else { Write-Output 'error: curl: (56) The requested URL returned error: 504' }
if ($Scenario -eq 'checksum') { Write-Output 'error: SHA512 hash mismatch' }
Write-Output 'Download failed, halting portfile.'
exit 1
'@ | Set-Content -LiteralPath $fixture -Encoding utf8

  foreach ($scenario in @('success', 'recover', 'recover-http', 'exhausted', 'compile', 'not-found', 'proxy-denied', 'checksum', 'partial-transfer')) {
    $script:waits.Clear()
    $state = Join-Path $temporary ($scenario + '.count')
    $failed = $false
    try {
      Invoke-VpnDependencyInstall -Executable $executable -Arguments @('-NoProfile', '-File', $fixture, '-State', $state, '-Scenario', $scenario) -Wait $wait
    } catch {
      if ($_.Exception.Message -notlike 'The native VPN dependencies did not build*') { throw }
      $failed = $true
    }
    $expectedAttempts = if ($scenario -in @('recover', 'recover-http')) { 2 } elseif ($scenario -eq 'exhausted') { 3 } else { 1 }
    Assert-Equal ([int](Get-Content -LiteralPath $state -Raw)) $expectedAttempts "$scenario invocation count"
    Assert-Equal $script:waits.Count ($expectedAttempts - 1) "$scenario retry waits"
    Assert-Equal $failed ($scenario -notin @('success', 'recover', 'recover-http')) "$scenario failure propagation"
    if ($expectedAttempts -gt 1) { Assert-Equal $script:waits[0] 5 "$scenario first backoff" }
    if ($expectedAttempts -gt 2) { Assert-Equal $script:waits[1] 10 "$scenario second backoff" }
  }
  Write-Output 'PASS 9 dependency transfer retry cases; compiler, checksum and permanent download failures remain fatal.'
} finally {
  $resolved = [IO.Path]::GetFullPath($temporary)
  if ([IO.Path]::GetDirectoryName($resolved) -cne [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetTempPath()) -or
    -not [IO.Path]::GetFileName($resolved).StartsWith('dsh-vpn-download-test-', [StringComparison]::Ordinal)) {
    throw 'Refusing to remove an unexpected dependency fixture directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
