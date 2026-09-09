/** Password-free Client snapshots with lifecycle events and cancellable Remote operations. */
import type {} from '@deepseek-ai/dsh-api-vpn-controller/remote'
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { SaveVpnRequest, VpnSettingsView } from '@deepseek-ai/dsh-network/types'
import type {} from '../types.ts'

/** Generated VPN Remote namespace. */
export type VpnRemote = TypertClientRemote['vpn']

/** Client query and action state; drafts and passwords remain in the settings component. */
export interface VpnClientSnapshot {
  /** First-load query state. */
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** Latest redacted Host view. */
  readonly data: VpnSettingsView | null
  /** Whether any configuration or connection command is pending. */
  readonly busy: boolean
  /** Sanitized operation code, or null. */
  readonly error: string | null
}

/** Owns redacted query state and suppresses publications after disposal. */
export class ClientVpnModel implements ObservableSnapshot<VpnClientSnapshot> {
  private view: VpnClientSnapshot = { status: 'idle', data: null, busy: false, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private read: AbortController | undefined
  private events = 0
  private actions = 0
  private commandSequence = 0

  /** @param remote - generated VPN Remote namespace. */
  constructor(private readonly remote: VpnRemote) {}

  /** @returns the current identity-stable snapshot. */
  getSnapshot = (): VpnClientSnapshot => this.view

  /**
   * @param listener - receives invalidation after a committed view update.
   * @returns an unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.lifetime.signal.aborted) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Accept a newer redacted Host lifecycle event.
   * @param data - configuration and tunnel status without credentials.
   */
  accept(data: VpnSettingsView): void {
    this.events++
    this.publish({ ...this.view, status: 'ready', data, error: null })
  }

  /**
   * Refresh the redacted view while retaining the previous data during loading.
   * @returns settlement after loading the initial view; errors are stored in the snapshot.
   */
  load(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.read?.abort()
    const controller = new AbortController()
    this.read = controller
    const observed = this.events
    const command = this.commandSequence
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const current = (): boolean => !signal.aborted && this.events === observed && this.commandSequence === command
    return this.track(async () => {
      this.publish({ ...this.view, status: 'loading', error: null })
      if (!current()) return
      try {
        const result = await this.remote.get(signal)
        if (!current()) return
        if (result.ok) this.publish({ ...this.view, status: 'ready', data: result.value })
        else this.publish({ ...this.view, status: 'error', error: failureCode(result.error) })
      } catch { if (current()) this.publish({ ...this.view, status: 'error', error: 'VPN_RPC_FAILED' }) }
    })
  }

  /**
   * Persist a local settings draft and request connection startup.
   * @param request - local form draft; retained only until the Remote call settles.
   * @returns true after settings are committed, including a recorded connection failure.
   */
  saveAndConnect(request: SaveVpnRequest): Promise<boolean> {
    return this.command(() => this.remote.saveAndConnect(request, this.lifetime.signal))
  }

  /**
   * Request a fresh connection with the saved settings.
   * @returns settlement after requesting a fresh connection attempt.
   */
  async connect(): Promise<void> { await this.command(() => this.remote.connect(this.lifetime.signal)) }

  /**
   * Cancel a pending connection or stop the active tunnel.
   * @returns settlement after disconnecting, including while another connect call is pending.
   */
  async disconnect(): Promise<void> { await this.command(() => this.remote.disconnect(this.lifetime.signal)) }

  /**
   * Stop notifications, cancel active calls, and await their settlement.
   * @returns settlement after cancellation and every owned Remote operation has stopped.
   */
  async dispose(): Promise<void> {
    this.listeners.clear()
    this.lifetime.abort()
    this.read?.abort()
    await Promise.allSettled(this.active)
  }

  private command(call: () => ReturnType<VpnRemote['get']>): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.resolve(false)
    this.read?.abort()
    const command = ++this.commandSequence
    const observed = this.events
    const current = (): boolean => !this.lifetime.signal.aborted && this.commandSequence === command
    this.actions++
    return this.track(async () => {
      this.publish({ ...this.view, busy: true, error: null })
      try {
        if (!current()) return false
        const result = await call()
        if (this.lifetime.signal.aborted) return false
        if (!result.ok) {
          if (current()) this.publish({ ...this.view, error: failureCode(result.error) })
          return false
        }
        if (current()) {
          if (this.events === observed) this.publish({ ...this.view, status: 'ready', data: result.value, error: null })
          else if (result.value.failure?.code === 'VPN_PROVIDER_CONFIGURATION_FAILED'
            || result.value.failure?.code === 'VPN_SAVED_CONNECTION_FAILED') {
            this.publish({ ...this.view, error: result.value.failure.code })
          }
        }
        return true
      } catch {
        if (current()) this.publish({ ...this.view, error: 'VPN_RPC_FAILED' })
        return false
      }
      finally { this.actions--; this.publish({ ...this.view, busy: this.actions !== 0 }) }
    })
  }

  private track<T>(run: () => Promise<T>): Promise<T> {
    const operation = Promise.withResolvers<undefined>()
    this.active.add(operation.promise)
    return (async () => {
      try { return await run() }
      finally {
        this.active.delete(operation.promise)
        operation.resolve(undefined)
      }
    })()
  }

  private publish(view: VpnClientSnapshot): void {
    if (this.lifetime.signal.aborted) return
    this.view = view
    notifySubscribers(this.listeners, '[vpn-controller]')
  }
}

function failureCode(error: RemoteFailure): string {
  return error.code === 'vpn/rejected' ? error.details.code : 'VPN_RPC_FAILED'
}
