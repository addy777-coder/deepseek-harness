/** Local settings Remote consumer of the application networking capability. */
import { type Context } from '@deepseek-ai/cordis'
import { NetworkError } from '@deepseek-ai/dsh-network'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SaveVpnRequest, VpnSettingsView } from '@deepseek-ai/dsh-network/types'

export type * from './types.ts'

const file = z.object({ name: z.string().min(1).max(255), content: z.string().max(786432) }).strict()
const saveSchema = z.object({ profile: file.optional(), files: z.array(file).max(16).optional(),
  username: z.string().min(1).max(1024), password: z.string().min(1).max(4096).optional(), autoConnect: z.boolean() }).strict()

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Remote owner of VPN configuration and connection controls. */
    vpnController: VpnController
  }
}

/** Exposes password-free VPN status and write-only configuration commands. */
export class VpnController extends TypertRemoteService {
  private connectionIntent = 0

  /** @param ctx - Host context with an optional network implementation. */
  constructor(ctx: Context) { super(ctx, 'vpnController', { namespace: 'vpn' }) }

  /**
   * Read the application's current VPN status.
   * @param signal - cancels a read before it starts.
   * @returns redacted VPN state, including unsupported deployments.
   */
  @Remote
  async get(signal?: AbortSignal): Promise<VpnSettingsView> {
    return this.operation(async () => {
      if (signal?.aborted) throw new NetworkError('VPN_OPERATION_CANCELLED')
      const service = this.ctx.get('network')
      return service ? service.get() : { supported: false, profileName: null, username: '', passwordConfigured: false,
        autoConnect: false, connection: 'unconfigured', failure: null }
    })
  }

  /**
   * Save validated credentials and start the tunnel; the existing company provider opts into VPN on first configuration.
   * @param request - imported files and write-only password.
   * @param signal - cancels profile validation before persistence.
   * @returns redacted state after the connection attempt; connection failures remain visible in its failure field.
   */
  @Remote
  async saveAndConnect(request: SaveVpnRequest, signal: AbortSignal): Promise<VpnSettingsView> {
    const parsed = saveSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('vpn/rejected', 'VPN_SETTINGS_INVALID', { code: 'VPN_SETTINGS_INVALID' })
    const intent = ++this.connectionIntent
    const current = (): boolean => intent === this.connectionIntent && !signal.aborted
    return this.operation(async () => {
      const service = this.requireNetwork()
      const initial = (await service.get()).profileName === null
      const draft = parsed.data
      await service.save({ username: draft.username, autoConnect: draft.autoConnect,
        ...(draft.password === undefined ? {} : { password: draft.password }),
        ...(draft.profile === undefined ? {} : { profile: draft.profile }),
        ...(draft.files === undefined ? {} : { files: draft.files }) }, signal)
      if (!current()) return service.get()
      if (initial) {
        try { await this.configureCompanyProvider() }
        catch { return { ...await service.get(), failure: { code: 'VPN_PROVIDER_CONFIGURATION_FAILED' } } }
      }
      if (!current()) return service.get()
      try { await service.connect() }
      catch { return { ...await service.get(), failure: { code: 'VPN_SAVED_CONNECTION_FAILED' } } }
      return service.get()
    })
  }

  /**
   * Replace the current tunnel with a fresh connection attempt.
   * @param signal - prevents connection startup if cancelled before replacement finishes.
   * @returns redacted state after the attempt settles.
   */
  @Remote
  async connect(signal?: AbortSignal): Promise<VpnSettingsView> {
    const intent = ++this.connectionIntent
    const current = (): boolean => intent === this.connectionIntent && !signal?.aborted
    return this.operation(async () => {
      const service = this.requireNetwork()
      if (signal?.aborted) return service.get()
      await service.disconnect()
      if (current()) await service.connect()
      return service.get()
    })
  }

  /**
   * Cancel pending connection intent and stop the active tunnel.
   * @param signal - cancels before shutdown starts; an accepted shutdown always finishes.
   * @returns redacted state after all owned tunnel resources have stopped.
   */
  @Remote
  async disconnect(signal?: AbortSignal): Promise<VpnSettingsView> {
    this.connectionIntent++
    return this.operation(async () => {
      const service = this.requireNetwork()
      if (signal?.aborted) return service.get()
      await service.disconnect()
      return service.get()
    })
  }

  private requireNetwork() {
    const service = this.ctx.get('network')
    if (!service) throw new NetworkError('VPN_PLATFORM_UNSUPPORTED')
    return service
  }

  private async operation(action: () => Promise<VpnSettingsView>): Promise<VpnSettingsView> {
    try { return await action() }
    catch (error) {
      const code = error instanceof NetworkError ? error.code : 'VPN_OPERATION_FAILED'
      throw new RemoteError('vpn/rejected', code, { code })
    }
  }

  private async configureCompanyProvider(): Promise<void> {
    const settings = this.ctx.get('settings')
    const entry = settings?.describe().find(item => item.ns === 'llm-pi-ai')
    const section = z.object({ providers: z.record(z.string(), z.looseObject({ api: z.string().optional() })) }).safeParse(entry?.value)
    if (!settings || !entry || !section.success || section.data.providers.gongsi?.api !== 'anthropic-messages') return
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gongsi', 'network'], value: 'vpn' }], entry.revision)
  }
}

export default VpnController
