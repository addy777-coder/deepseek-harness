/** VPN settings wire types; reads contain neither profile contents nor passwords. */
export type { SaveVpnRequest, VpnSettingsView, VpnFailure, VpnConnectionState } from '@deepseek-ai/dsh-network/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection {
    /** Network lifecycle state consumed by the VPN settings controller. */
    'network/changed': true
  }

  interface RemoteErrorDetailsMap {
    /** A sanitized VPN operation refusal without credentials or imported file contents. */
    'vpn/rejected': { readonly code: string }
  }
}
