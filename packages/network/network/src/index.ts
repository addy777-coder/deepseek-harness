/** Service Definition for application-owned model networking, implemented by network-openvpn. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { NetworkTarget, NetworkTargetId, SaveVpnRequest, VpnSettingsView } from './types.ts'

export type * from './types.ts'

/**
 * Brand a consumer-owned destination identifier.
 * @param value - stable identifier used by the registering model consumer.
 * @returns the destination identifier.
 */
export function networkTargetId(value: string): NetworkTargetId {
  if (!value || value.length > 256 || /[\0\r\n]/u.test(value)) throw new TypeError('Invalid network target identifier')
  return value as NetworkTargetId
}

/** A sanitized failure that never retains credentials, request headers, or an upstream exception. */
export class NetworkError extends Error {
  /**
   * @param code - stable local diagnostic code.
   */
  constructor(readonly code: string) {
    super(`VPN operation failed (${code}).`)
    this.name = 'NetworkError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Application-only model networking and local VPN configuration. */
    network: NetworkService
  }
}

/**
 * Application-owned tunnel service. Consumers register configured model destinations through effects.
 * Requests fail when the tunnel is unavailable; implementations must never retry them through host networking.
 */
export abstract class NetworkService extends Service {
  /** @param ctx - owning plugin context. */
  constructor(ctx: Context) { super(ctx, 'network') }

  /** Read local VPN state without exposing credentials.
   * @returns redacted configuration and current connection state.
   */
  abstract get(): Promise<VpnSettingsView>

  /**
   * Validate an import and commit its credential reference and startup preference.
   * @param request - local profile files and credentials; passwords are write-only.
   * @param signal - cancels validation before the durable commit.
   * @returns settlement after persistence; connection is a separate operation.
   */
  abstract save(request: SaveVpnRequest, signal?: AbortSignal): Promise<void>

  /** Start a connection with the saved profile and credentials.
   * @returns settlement after connection succeeds or its redacted failure is published.
   */
  abstract connect(): Promise<void>

  /** Cancel pending connection intent and stop the current tunnel.
   * @returns settlement after all owned requests and the helper process have stopped.
   */
  abstract disconnect(): Promise<void>

  /**
   * Allow one configured model destination until its consumer unloads.
   * @param id - consumer-owned destination identifier.
   * @param target - absolute API root; credentials and fragments are rejected.
   * @returns an idempotent disposer that revokes this registration and its active requests.
   */
  abstract registerTarget(id: NetworkTargetId, target: NetworkTarget): () => void

  /**
   * Fetch through the owned tunnel while preserving response streaming and cancellation.
   * @param id - an active registered destination.
   * @param input - HTTP request URL under the registered API root.
   * @param init - Fetch options; redirects never escape the registered destination.
   * @returns a streaming response, or a sanitized failure without direct fallback.
   */
  abstract fetch(id: NetworkTargetId, input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export default NetworkService
