/** Versioned frames exchanged by one desktop Renderer and the GUI Host. */

/** Current desktop transport protocol version. */
export const DESKTOP_TRANSPORT_VERSION = 1 as const

/** Correlation id minted by the Renderer. */
export type DesktopRequestId = string & { readonly __desktopRequestId: unique symbol }

/** Window identity minted by the Electron main process. */
export type DesktopWindowId = string & { readonly __desktopWindowId: unique symbol }

/** Startup phase reported by the Host Utility Process. */
export type DesktopHostStartupPhase = 'bootstrap' | 'profile' | 'loader'

/** Renderer-to-Host transport frames. */
export type DesktopClientFrame =
  | { readonly v: 1; readonly t: 'boot'; readonly id: DesktopRequestId }
  | {
    readonly v: 1
    readonly t: 'fetch'
    readonly id: DesktopRequestId
    readonly url: string
    readonly method: string
    readonly headers: readonly (readonly [string, string])[]
    readonly body?: ArrayBuffer
  }
  | { readonly v: 1; readonly t: 'bundle'; readonly id: DesktopRequestId; readonly url: string }
  | {
    readonly v: 1
    readonly t: 'stream-open'
    readonly id: DesktopRequestId
    readonly endpoint: string
    readonly payload: unknown
  }
  | { readonly v: 1; readonly t: 'stream-pull'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'abort'; readonly id: DesktopRequestId }

/** Host-to-Renderer transport frames. */
export type DesktopHostFrame =
  | { readonly v: 1; readonly t: 'boot-result'; readonly id: DesktopRequestId; readonly injections: readonly unknown[] }
  | {
    readonly v: 1
    readonly t: 'fetch-result'
    readonly id: DesktopRequestId
    readonly status: number
    readonly statusText: string
    readonly headers: readonly (readonly [string, string])[]
    readonly body: ArrayBuffer
  }
  | {
    readonly v: 1
    readonly t: 'bundle-result'
    readonly id: DesktopRequestId
    readonly contentType: string
    readonly body: ArrayBuffer
  }
  | { readonly v: 1; readonly t: 'stream-item'; readonly id: DesktopRequestId; readonly value: unknown }
  | { readonly v: 1; readonly t: 'stream-ready'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'stream-end'; readonly id: DesktopRequestId }
  | {
    readonly v: 1
    readonly t: 'stream-error'
    readonly id: DesktopRequestId
    readonly failure: { readonly code: string; readonly message: string; readonly details: object }
  }
  | { readonly v: 1; readonly t: 'fault'; readonly id: DesktopRequestId; readonly message: string }

/** Main-process control frame delivered to the Utility Process. */
export type DesktopHostControlFrame =
  | { readonly v: 1; readonly t: 'attach'; readonly windowId: DesktopWindowId }
  | { readonly v: 1; readonly t: 'shutdown' }

/** Utility Process lifecycle frame delivered to the Electron main process. */
export type DesktopHostLifecycleFrame =
  | { readonly v: 1; readonly t: 'startup'; readonly phase: DesktopHostStartupPhase }
  | { readonly v: 1; readonly t: 'ready' }
  | { readonly v: 1; readonly t: 'stopped' }

/**
 * Parse one untrusted Utility Process lifecycle frame without accepting extra fields.
 * @param value - candidate frame received by the Electron main process.
 * @returns the validated startup, ready, or stopped frame.
 */
export function parseDesktopHostLifecycleFrame(value: unknown): DesktopHostLifecycleFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('desktop transport: invalid lifecycle frame')
  }
  const record = value as Record<string, unknown>
  if (record.v !== DESKTOP_TRANSPORT_VERSION) {
    throw new TypeError('desktop transport: invalid lifecycle frame')
  }
  if (record.t === 'ready' || record.t === 'stopped') {
    if (Object.keys(record).length !== 2) {
      throw new TypeError(`desktop transport: invalid ${record.t} lifecycle frame`)
    }
    return { v: 1, t: record.t }
  }
  if (record.t === 'startup'
    && (record.phase === 'bootstrap' || record.phase === 'profile' || record.phase === 'loader')
    && Object.keys(record).length === 3) {
    return { v: 1, t: 'startup', phase: record.phase }
  }
  throw new TypeError('desktop transport: invalid lifecycle frame')
}
