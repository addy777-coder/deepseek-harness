/** Client VPN commands and redacted Host-event synchronization. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { ClientVpnModel, type VpnClientSnapshot } from './model.ts'
import type { SaveVpnRequest } from '@deepseek-ai/dsh-network/types'

export { ClientVpnModel } from './model.ts'
export type { VpnClientSnapshot, VpnRemote } from './model.ts'
export type * from '../types.ts'

/** Client-only VPN configuration commands. */
export interface IVpn {
  /** Password-free observable configuration and connection state. */
  readonly snapshot: ObservableSnapshot<VpnClientSnapshot>
  /**
   * Refresh the redacted Host status while retaining the current data.
   * @returns settlement after refreshing status.
   */
  load(): Promise<void>
  /**
   * Persist the local draft and request connection startup.
   * @param request - local profile and account draft.
   * @returns whether persistence succeeded; connection errors remain in the snapshot.
   */
  saveAndConnect(request: SaveVpnRequest): Promise<boolean>
  /**
   * Request a fresh connection using the saved settings.
   * @returns settlement after requesting reconnection.
   */
  connect(): Promise<void>
  /**
   * Cancel pending connection intent and stop the active tunnel.
   * @returns settlement after requesting complete tunnel shutdown.
   */
  disconnect(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Redacted Client VPN state and controls. */
    vpn: IVpn
  }
}

/** Client service whose model never retains a password draft. */
export class VpnClientController extends Service implements IVpn {
  readonly snapshot: ObservableSnapshot<VpnClientSnapshot>
  /**
   * @param ctx - Client plugin context.
   * @param model - owned Remote query model.
   */
  constructor(ctx: Context, private readonly model: ClientVpnModel) {
    super(ctx, 'vpn')
    this.snapshot = model
    ctx.effect(() => () => model.dispose())
  }
  load(): Promise<void> { return this.model.load() }
  saveAndConnect(request: SaveVpnRequest): Promise<boolean> { return this.model.saveAndConnect(request) }
  connect(): Promise<void> { return this.model.connect() }
  disconnect(): Promise<void> { return this.model.disconnect() }
}

/** Required generated Remote services. */
export const inject = ['remote', 'remote.vpn']

/**
 * Mount VPN state and refresh it after transport reconnection.
 * @param ctx - Client context with the generated VPN namespace.
 */
export function apply(ctx: Context): void {
  const model = new ClientVpnModel(ctx.remote.vpn)
  new VpnClientController(ctx, model)
  ctx.effect(() => ctx.remote.$on('network/changed', (view) => { model.accept(view) }))
  ctx.on('connection/reset', () => { void model.load() })
}
