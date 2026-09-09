/** Redacted VPN state and synthetic account data shared by Host and Client tests. */
import type { SaveVpnRequest, VpnSettingsView } from '../src/types.ts'

export const request: SaveVpnRequest = { username: 'employee', password: 'local-only-secret', autoConnect: true }

export function view(connection: VpnSettingsView['connection'] = 'disconnected'): VpnSettingsView {
  return { supported: true, profileName: 'company.ovpn', username: 'employee', passwordConfigured: true,
    autoConnect: true, connection, failure: null }
}
