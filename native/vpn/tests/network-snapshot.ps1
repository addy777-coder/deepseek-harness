#Requires -Version 7.0
[CmdletBinding()]
param([switch]$AsJson)
$ErrorActionPreference = 'Stop'

function Invoke-VpnSnapshotCommand([string]$Program, [string[]]$Arguments) {
  $lines = & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'VPN_LIVE_NETWORK_SNAPSHOT_FAILED' }
  $lines -join "`n"
}

function Get-VpnNetworkSnapshot {
  if ($IsWindows) {
    $routes = @(Get-NetRoute | Select-Object InterfaceIndex, AddressFamily, DestinationPrefix, NextHop, RouteMetric | Sort-Object InterfaceIndex, AddressFamily, DestinationPrefix, NextHop, RouteMetric)
    $dns = @(Get-DnsClientServerAddress | Select-Object InterfaceIndex, AddressFamily, ServerAddresses | Sort-Object InterfaceIndex, AddressFamily)
    $interfaces = @(Get-NetAdapter -IncludeHidden | Select-Object InterfaceIndex, InterfaceGuid, InterfaceDescription | Sort-Object InterfaceIndex)
  } elseif ($IsMacOS) {
    # Expiry and cache counters do not describe configured routes.
    $routes = @(foreach ($family in @('inet', 'inet6')) {
      $table = Invoke-VpnSnapshotCommand netstat @('-rn', '-f', $family)
      foreach ($line in $table -split "`n") {
        $fields = $line.Trim() -split '\s+'
        if ($fields.Count -ge 4 -and $fields[0] -ne 'Destination' -and $fields[2] -match '^[A-Za-z0-9!]+$') {
          ($fields[0..3]) -join ' '
        }
      }
    }) | Sort-Object
    if (-not $routes) { throw 'VPN_LIVE_NETWORK_SNAPSHOT_INVALID' }
    $dns = Invoke-VpnSnapshotCommand scutil @('--dns')
    $interfaces = Invoke-VpnSnapshotCommand ifconfig @('-a')
  } elseif ($IsLinux) {
    $routes = @(foreach ($family in @('-4', '-6')) {
      $routeJson = Invoke-VpnSnapshotCommand ip @($family, '-j', 'route', 'show', 'table', 'all')
      $routeJson | ConvertFrom-Json | Select-Object type, dst, gateway, dev, table, protocol, scope, prefsrc, metric
    }) | Sort-Object table, dst, dev, gateway
    $addressJson = Invoke-VpnSnapshotCommand ip @('-j', 'address', 'show')
    $interfaces = @($addressJson | ConvertFrom-Json | ForEach-Object {
      [ordered]@{ ifindex = $_.ifindex; ifname = $_.ifname; mtu = $_.mtu; address = $_.address
        addresses = @($_.addr_info | Select-Object family, local, prefixlen, scope | Sort-Object family, local) }
    })
    $dns = [ordered]@{ resolvConf = [IO.File]::ReadAllText('/etc/resolv.conf') }
    if (Get-Command resolvectl -CommandType Application -ErrorAction SilentlyContinue) {
      $dns.linkServers = Invoke-VpnSnapshotCommand resolvectl @('dns')
    }
  } else { throw 'VPN_PLATFORM_UNSUPPORTED' }
  [pscustomobject]@{
    network = [ordered]@{ routes = $routes; dns = $dns; interfaces = $interfaces } | ConvertTo-Json -Depth 8 -Compress
    externalOpenvpnActive = [bool](Get-Process -Name openvpn -ErrorAction SilentlyContinue)
    helperCount = @(Get-Process -Name dsh-vpn -ErrorAction SilentlyContinue).Count
  }
}

if ($AsJson) { Get-VpnNetworkSnapshot | ConvertTo-Json -Compress }
