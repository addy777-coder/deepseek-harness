#Requires -Version 7.0

# Retry only failed upstream transfers; vcpkg remains responsible for hashes and compilation.
function Invoke-VpnDependencyInstall {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string[]]$Arguments,
    [ValidateRange(1, 5)][int]$MaxAttempts = 3,
    [scriptblock]$Wait = { param([int]$Seconds) Start-Sleep -Seconds $Seconds }
  )
  $PSNativeCommandUseErrorActionPreference = $false
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $transientTransfer = $false
    $downloadFailed = $false
    $invalidHash = $false
    $permanentHttpFailure = $false
    & $Executable @Arguments 2>&1 | ForEach-Object {
      $line = [string]$_
      if ($line -match 'curl: \((5|6|7|18|28|52|56|92)\)' -or
        $line -match 'curl: \(22\).*returned error: (408|429|500|502|503|504)\b') { $transientTransfer = $true }
      if ($line -match 'Download failed, halting portfile') { $downloadFailed = $true }
      if ($line -match '(?i)hash mismatch|mismatched hash|expected hash|actual hash') { $invalidHash = $true }
      if ($line -match 'returned error: (4\d\d)\b' -and $Matches[1] -notin @('408', '429')) { $permanentHttpFailure = $true }
      Write-Host $line
    }
    if ($LASTEXITCODE -eq 0) { return }
    if (-not $transientTransfer -or -not $downloadFailed -or $invalidHash -or $permanentHttpFailure -or $attempt -eq $MaxAttempts) {
      throw "The native VPN dependencies did not build (exit $LASTEXITCODE, attempt $attempt/$MaxAttempts)."
    }
    Write-Warning "Transient VPN dependency download failure; retrying attempt $($attempt + 1)/$MaxAttempts."
    & $Wait (5 * $attempt)
  }
}
