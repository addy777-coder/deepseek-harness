#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/common.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('dsh-vpn-toolchain-test-' + [Guid]::NewGuid().ToString('N'))
$first = Join-Path $temporary 'first'
$second = Join-Path $temporary 'second'
$previousPath = $env:PATH
$name = 'dsh-vpn-toolchain-probe'
$binary = if ($IsWindows) { $name + '.cmd' } else { $name }
try {
  [void][IO.Directory]::CreateDirectory($first)
  [void][IO.Directory]::CreateDirectory($second)
  foreach ($directory in @($first, $second)) {
    $file = Join-Path $directory $binary
    Set-Content -LiteralPath $file -Value $(if ($IsWindows) { '@exit /b 0' } else { "#!/bin/sh`nexit 0" })
    if (-not $IsWindows) {
      & chmod 755 $file
      if ($LASTEXITCODE -ne 0) { throw 'Could not make toolchain fixture executable.' }
    }
  }
  $env:PATH = $first + [IO.Path]::PathSeparator + $second + [IO.Path]::PathSeparator + $previousPath
  $matches = @(Get-Command $name -CommandType Application -All)
  if ($matches.Count -ne 2) { throw 'Toolchain fixture must expose two applications.' }
  $selected = Get-VpnApplicationPath $name
  if ($selected -isnot [string] -or $selected -cne (Join-Path $first $binary)) {
    throw 'Toolchain selection must return the first executable path as one string.'
  }
  $missingRejected = $false
  try { Get-VpnApplicationPath ('dsh-vpn-missing-' + [Guid]::NewGuid().ToString('N')) | Out-Null }
  catch [System.Management.Automation.CommandNotFoundException] { $missingRejected = $true }
  if (-not $missingRejected) { throw 'A missing native tool must reject discovery.' }
  Write-Output 'PASS native toolchain PATH precedence and missing-tool rejection.'
} finally {
  $env:PATH = $previousPath
  $resolved = [IO.Path]::GetFullPath($temporary)
  if ([IO.Path]::GetDirectoryName($resolved) -cne [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetTempPath()) -or
    -not [IO.Path]::GetFileName($resolved).StartsWith('dsh-vpn-toolchain-test-', [StringComparison]::Ordinal)) {
    throw 'Refusing to remove an unexpected toolchain fixture directory.'
  }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
