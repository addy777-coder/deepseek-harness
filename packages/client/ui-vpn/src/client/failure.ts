/** Translate sanitized VPN failure codes without displaying raw error messages. */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { VpnLocaleKey } from './locales.ts'

const messages = new Map<string, VpnLocaleKey>([
  ['AUTH_FAILED', 'authenticationFailed'],
  ['CREDENTIALS_REJECTED', 'authenticationFailed'],
  ['CONNECTION_TIMEOUT', 'connectionTimedOut'],
  ['NATIVE_CONNECTION_TIMEOUT', 'connectionTimedOut'],
  ['VPN_CONNECT_TIMEOUT', 'connectionTimedOut'],
  ['PROFILE_IMPORT_FAILED', 'referenceMissing'],
  ['PROFILE_REFERENCE_MISSING', 'referenceMissing'],
  ['VPN_PROFILE_REFERENCE_MISSING', 'referenceMissing'],
  ['VPN_PROFILE_MISSING', 'profileRequired'],
  ['VPN_PROFILE_SYNTAX', 'profileRejected'],
  ['VPN_PROFILE_INVALID', 'profileRejected'],
  ['VPN_PROFILE_REJECTED', 'profileRejected'],
  ['VPN_PROFILE_UNSUPPORTED_OPTION', 'profileRejected'],
  ['VPN_PROFILE_TOO_LARGE', 'importTooLarge'],
  ['VPN_IMPORT_DUPLICATE_FILE', 'duplicateFiles'],
  ['VPN_PROFILE_INVALID_CERTIFICATE', 'certificateInvalid'],
  ['PROFILE_REJECTED_BY_OPENVPN3', 'profileRejected'],
  ['UNSUPPORTED_AUTHENTICATION', 'profileRejected'],
  ['VPN_AUTHENTICATION_UNSUPPORTED', 'profileRejected'],
  ['PROTOTYPE_REQUIRES_IPV4_TUNNEL', 'profileRejected'],
  ['VPN_CREDENTIALS_MISSING', 'credentialsMissing'],
  ['VPN_CREDENTIAL_RECORD_INVALID', 'credentialsMissing'],
  ['VPN_CREDENTIAL_REFERENCE_INVALID', 'credentialsMissing'],
  ['NATIVE_HELPER_NOT_BUILT', 'runtimeMissing'],
  ['VPN_RUNTIME_MISSING', 'runtimeMissing'],
  ['VPN_RUNTIME_INTEGRITY_FAILED', 'runtimeInvalid'],
  ['VPN_NATIVE_PROTOCOL_INVALID', 'runtimeInvalid'],
  ['VPN_NATIVE_INPUT_FAILED', 'runtimeInvalid'],
  ['VPN_NATIVE_EXITED', 'runtimeMissing'],
  ['VPN_UNSUPPORTED_PLATFORM', 'unsupported'],
  ['VPN_PLATFORM_UNSUPPORTED', 'unsupported'],
  ['VPN_NOT_CONNECTED', 'notConnected'],
  ['VPN_REQUEST_FAILED', 'requestFailed'],
  ['VPN_PROVIDER_CONFIGURATION_FAILED', 'savedProviderFailed'],
  ['VPN_SAVED_CONNECTION_FAILED', 'savedConnectionFailed'],
  ['VPN_OPERATION_CANCELLED', 'operationCancelled'],
  ['VPN_OPERATION_FAILED', 'operationFailed'],
  ['VPN_RPC_FAILED', 'operationFailed'],
  ['VPN_SETTINGS_INVALID', 'settingsInvalid'],
  ['CERT_VERIFY_FAIL', 'certificateFailed'],
  ['TLS_VERSION_MIN', 'profileRejected'],
  ['TLS_ALERT_MISC', 'certificateFailed'],
  ['DNS_RESOLVE_ERROR', 'dnsFailed'],
  ['CONNECTION_FAILED', 'transportFailed'],
  ['VPN_CONNECTION_LOST', 'transportFailed'],
  ['VPN_CONNECTION_FAILED', 'transportFailed'],
  ['VPN_SHUTDOWN_FAILED', 'shutdownFailed'],
])

/**
 * Render a known failure reason or the localized wrapper for an opaque status code.
 * @param code - Redacted status code from the VPN controller.
 * @param t - VPN settings translation function.
 * @returns Localized reason without native exception or profile contents.
 */
export function vpnFailureText(code: string, t: Translate<VpnLocaleKey>): string {
  return t(messages.get(code) ?? 'failureUnknown', { code })
}
