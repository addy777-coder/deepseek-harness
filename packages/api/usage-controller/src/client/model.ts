/** React-free usage query state with cancellation and latest-request publication. */

import type {} from '@deepseek-ai/dsh-api-usage-controller/remote'
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { UsageRequest, UsageSnapshot } from '../types.ts'

/** Generated usage Remote namespace, including its optional cancellation signal. */
export type UsageRemote = TypertClientRemote['usage']

/** Query lifecycle and the last complete usage result retained during loading or failure. */
export interface UsageClientSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly request: UsageRequest | null
  readonly data: UsageSnapshot | null
  readonly error: string | null
}

/** Cancellation may change while a Remote response is pending. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Owns usage reads; a superseded or disposed read cannot publish a result. */
export class ClientUsageModel implements ObservableSnapshot<UsageClientSnapshot> {
  private view: UsageClientSnapshot = { status: 'idle', request: null, data: null, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private current: AbortController | undefined

  /** @param remote - generated usage query namespace. */
  constructor(private readonly remote: UsageRemote) {}

  /** @returns the current identity-stable query snapshot. */
  getSnapshot = (): UsageClientSnapshot => this.view

  /**
   * Subscribe to query state changes until unsubscribed or disposed.
   * @param listener - invalidation callback; exceptions do not interrupt other subscribers.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.lifetime.signal.aborted) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Cancel the preceding read and load one selected range.
   * @param request - range and client-resolved IANA time zone.
   * @returns settlement after publishing success or failure; disposed calls do no work.
   */
  load(request: UsageRequest): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.current?.abort()
    const controller = new AbortController()
    this.current = controller
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const completion = Promise.withResolvers<void>()
    const operation = completion.promise
    this.pending.add(operation)
    this.publish({ ...this.view, status: 'loading', request, error: null })
    void this.read(request, signal).finally(() => {
      this.pending.delete(operation)
      if (this.current === controller) this.current = undefined
      completion.resolve()
    })
    return operation
  }

  /**
   * Reload the selected range with the browser's current time zone.
   * @returns the read settlement; no query starts before the first explicit load.
   */
  refresh(): Promise<void> {
    const request = this.view.request
    if (request === null || this.lifetime.signal.aborted) return Promise.resolve()
    return this.load({ ...request, timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone })
  }

  /**
   * Stop notifications, cancel every outstanding read, and await their settlement.
   * @returns completion after no owned query can publish or retain a transport operation.
   */
  async dispose(): Promise<void> {
    this.listeners.clear()
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async read(request: UsageRequest, signal: AbortSignal): Promise<void> {
    if (isAborted(signal)) return
    try {
      const result = await this.remote.get(request, signal)
      if (isAborted(signal)) return
      if (result.ok) {
        this.publish({ status: 'ready', request, data: result.value, error: null })
      } else {
        this.publish({ ...this.view, status: 'error', error: result.error.message })
      }
    } catch (error) {
      if (isAborted(signal)) return
      this.publish({
        ...this.view,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private publish(snapshot: UsageClientSnapshot): void {
    this.view = snapshot
    notifySubscribers(this.listeners, '[usage-controller]')
  }
}
