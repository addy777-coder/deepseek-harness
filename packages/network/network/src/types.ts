/** Local VPN configuration and model transport types; secrets are never part of status events. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A model consumer's registered network destination. */
export type NetworkTargetId = Branded<'NetworkTargetId'>

/** One imported file, supplied by the user rather than opened on the Host by pathname. */
export interface VpnImportFile {
  /** Display filename used to match references in the profile. */
  readonly name: string
  /** UTF-8 profile or certificate contents. */
  readonly content: string
}

/** Complete editable settings; omitted profile and password retain their stored values. */
export interface SaveVpnRequest {
  /** Replacement OpenVPN profile. */
  readonly profile?: VpnImportFile
  /** Files referenced by the replacement profile. */
  readonly files?: readonly VpnImportFile[]
  /** VPN login name, stored with the credential record. */
  readonly username: string
  /** Replacement password; never returned by configuration reads. */
  readonly password?: string
  /** Restore the connection when the application starts. */
  readonly autoConnect: boolean
}

/** Connection lifecycle exposed to local settings consumers. */
export type VpnConnectionState = 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Sanitized error code; caller interfaces own localized explanations. */
export interface VpnFailure {
  /** Stable error identifier without server addresses or credentials. */
  readonly code: string
  /** Optional safe explanation supplied by another network provider. */
  readonly message?: string
}

/** Redacted configuration and connection state. */
export interface VpnSettingsView {
  /** Whether this deployment supports the VPN implementation. */
  readonly supported: boolean
  /** Imported profile display filename, or null before configuration. */
  readonly profileName: string | null
  /** Stored login name; the password is omitted. */
  readonly username: string
  /** Whether the stored account has a password. */
  readonly passwordConfigured: boolean
  /** Whether application startup restores the connection. */
  readonly autoConnect: boolean
  /** Current tunnel lifecycle. */
  readonly connection: VpnConnectionState
  /** Most recent failure, cleared by a subsequent connection attempt. */
  readonly failure: VpnFailure | null
}

/** A configured model API root; requests must remain under this origin and path. */
export interface NetworkTarget {
  /** Absolute HTTP or HTTPS API base URL, without embedded credentials. */
  readonly baseURL: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Redacted VPN state after the provider commits a configuration or lifecycle change.
     * @mode emit
     * @param view - password-free local configuration and connection state.
     */
    'network/changed'(view: VpnSettingsView): void
  }
}
