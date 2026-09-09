/** Resolved native VPN process configuration. */

/** Deployment configuration for the local native network provider. */
export interface Config {
  /** Absolute helper path; defaults to the desktop-bundled VPN asset. */
  readonly executablePath?: string
  /** Expected helper digest; omitted reads its adjacent .sha256 file. */
  readonly executableSha256?: string
  /** Host directory for managed helper processes. */
  readonly dshHome?: string
  /** Seconds allowed for an OpenVPN connection attempt. */
  readonly connectTimeoutSeconds?: number
  /** Milliseconds allowed for process exit before tree termination. */
  readonly shutdownGraceMs?: number
  /** Initial delay between network-failure reconnect attempts. */
  readonly reconnectDelayMs?: number
  /** Maximum reconnect delay. Authentication failures are never retried. */
  readonly reconnectMaxDelayMs?: number
  /** Maximum concurrent proxy streams. */
  readonly maxConnections?: number
  /** Maximum time to receive an authenticated CONNECT header. */
  readonly headerTimeoutMs?: number
  /** Maximum time to connect a target through the tunnel. */
  readonly targetConnectTimeoutMs?: number
  /** lwIP timer polling interval. */
  readonly pollIntervalMs?: number
  /** Maximum pending IP packet bytes between lwIP and OpenVPN. */
  readonly maxPendingPacketBytes?: number
  /** Maximum aggregate bytes in a profile import. */
  readonly maxProfileBytes?: number
}

/** Native helper limits after the provider resolves deployment defaults. */
export interface NativeLimits {
  readonly connectTimeoutSeconds: number
  readonly maxConnections: number
  readonly headerTimeoutMs: number
  readonly targetConnectTimeoutMs: number
  readonly pollIntervalMs: number
  readonly maxPendingPacketBytes: number
}

/** Complete implementation inputs; defaults are resolved before executing operations. */
export interface ResolvedSpec extends NativeLimits {
  readonly executablePath: string
  readonly executableSha256?: string
  readonly cwd: string
  readonly shutdownGraceMs: number
  readonly reconnectDelayMs: number
  readonly reconnectMaxDelayMs: number
  readonly maxProfileBytes: number
}
