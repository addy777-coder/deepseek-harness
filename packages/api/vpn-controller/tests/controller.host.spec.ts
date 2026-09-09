/** Host commands validate imports and keep persistence separate from connection intent. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { NetworkError, NetworkService } from '@deepseek-ai/dsh-network'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VpnController, * as VpnModule from '../src/index.ts'
import { request, view } from './fixture.ts'

const contexts: Context[] = []
const pending = new Set<PromiseWithResolvers<undefined>>()
afterEach(async () => {
  for (const deferred of pending) deferred.resolve(undefined)
  pending.clear()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function deferred() {
  const result = Promise.withResolvers<undefined>()
  pending.add(result)
  return result
}

class FakeNetwork extends NetworkService {
  state = view()
  get = vi.fn<NetworkService['get']>(async () => this.state)
  save = vi.fn<NetworkService['save']>(async (request) => {
    this.state = { ...this.state, username: request.username, passwordConfigured: true,
      profileName: request.profile?.name ?? this.state.profileName ?? 'company.ovpn', autoConnect: request.autoConnect }
  })
  connect = vi.fn<NetworkService['connect']>(async () => { this.state = { ...this.state, connection: 'connected' } })
  disconnect = vi.fn<NetworkService['disconnect']>(async () => { this.state = { ...this.state, connection: 'disconnected' } })
  registerTarget = vi.fn<NetworkService['registerTarget']>(() => () => {})
  fetch = vi.fn<NetworkService['fetch']>().mockRejectedValue(new NetworkError('VPN_NOT_CONNECTED'))
}

async function bench(network = true) {
  const ctx = new Context()
  contexts.push(ctx)
  if (network) await ctx.plugin(FakeNetwork).await()
  const fiber = ctx.plugin(VpnController)
  await fiber.await()
  return { ctx, fiber, controller: ctx.vpnController, network: ctx.get('network') as FakeNetwork | undefined }
}

function settings(ctx: Context, value: unknown = { providers: { gongsi: { api: 'anthropic-messages' } } }) {
  const mutate = vi.fn().mockResolvedValue(undefined)
  ctx.provide('settings', { describe: () => [{ ns: 'llm-pi-ai', value, revision: 7 }], mutate })
  return mutate
}

describe('VPN Host controller', () => {
  it('mounts from cordis.yml and exposes the password-free network view', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['test:network', FakeNetwork], ['@deepseek-ai/dsh-api-vpn-controller', VpnModule]])
    ctx.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error('unexpected Loader import')
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
    await ctx.loader.await()
    expect(await ctx.vpnController.get()).toEqual(view())
    await ctx.vpnController.connect()
    expect((await ctx.vpnController.get()).connection).toBe('connected')
    await ctx.vpnController.disconnect()
    expect((await ctx.vpnController.get()).connection).toBe('disconnected')
    await ctx.fiber.dispose()
    expect(ctx.get('vpnController')).toBeUndefined()
  })

  it('reports unsupported deployments and refuses commands without a network provider', async () => {
    const { controller } = await bench(false)
    expect(await controller.get()).toMatchObject({ supported: false, profileName: null, connection: 'unconfigured' })
    await expect(controller.connect()).rejects.toMatchObject({ code: 'vpn/rejected', details: { code: 'VPN_PLATFORM_UNSUPPORTED' } })
  })

  it.each([
    { ...request, password: '' },
    { ...request, username: '' },
    { ...request, extra: 'private' },
    { ...request, profile: { name: 'company.ovpn', content: 'client', path: 'C:/private/profile.ovpn' } },
    { ...request, files: Array.from({ length: 17 }, () => ({ name: 'ca.crt', content: '' })) },
  ])('rejects invalid wire settings before invoking persistence', async (invalid) => {
    const { controller, network } = await bench()
    await expect(controller.saveAndConnect(invalid as never, new AbortController().signal)).rejects.toMatchObject({
      code: 'vpn/rejected', message: 'VPN_SETTINGS_INVALID', details: { code: 'VPN_SETTINGS_INVALID' },
    })
    expect(network!.save).not.toHaveBeenCalled()
  })

  it('persists write-only credentials before switching the initial company provider and connecting', async () => {
    const { controller, network, ctx } = await bench()
    network!.state = { ...view('unconfigured'), profileName: null, passwordConfigured: false }
    const mutate = settings(ctx)
    const signal = new AbortController().signal
    const imported = { ...request, profile: { name: 'company.ovpn', content: 'client\nca ca.crt\n' },
      files: [{ name: 'ca.crt', content: 'synthetic certificate' }] }
    const saved = await controller.saveAndConnect(imported, signal)
    expect(network!.save).toHaveBeenCalledExactlyOnceWith(imported, signal)
    expect(mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'gongsi', 'network'], value: 'vpn' }], 7)
    expect(network!.save.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0]!)
    expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(network!.connect.mock.invocationCallOrder[0]!)
    expect(saved).toEqual(view('connected'))
    expect(JSON.stringify(saved)).not.toContain('local-only-secret')
  })

  it.each([{}, { providers: {} }, { providers: { gongsi: { api: 'openai-completions' } } }])('does not alter another provider protocol', async (value) => {
    const { controller, network, ctx } = await bench()
    network!.state = { ...view(), profileName: null }
    const mutate = settings(ctx, value)
    await controller.saveAndConnect(request, new AbortController().signal)
    expect(mutate).not.toHaveBeenCalled()
    expect(network!.connect).toHaveBeenCalledOnce()
  })

  it('preserves explicit provider settings after the first VPN save and keeps an omitted password omitted', async () => {
    const { controller, network, ctx } = await bench()
    const mutate = settings(ctx)
    const draft = { username: 'updated', autoConnect: false }
    await controller.saveAndConnect(draft, new AbortController().signal)
    expect(network!.save.mock.calls[0]![0]).toEqual(draft)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('returns a committed save with a redacted follow-up failure when provider mutation fails', async () => {
    const { controller, network, ctx } = await bench()
    network!.state = { ...view(), profileName: null }
    settings(ctx).mockRejectedValue(new Error('private settings output'))
    await expect(controller.saveAndConnect(request, new AbortController().signal)).resolves.toMatchObject({
      passwordConfigured: true, profileName: 'company.ovpn', failure: { code: 'VPN_PROVIDER_CONFIGURATION_FAILED' },
    })
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('returns a committed save when connection setup throws', async () => {
    const { controller, network } = await bench()
    network!.connect.mockRejectedValueOnce(new Error('private connection detail'))
    await expect(controller.saveAndConnect(request, new AbortController().signal)).resolves.toMatchObject({
      passwordConfigured: true, failure: { code: 'VPN_SAVED_CONNECTION_FAILED' },
    })
  })

  it.each([new NetworkError('VPN_PROFILE_REFERENCE_MISSING'), new Error('private profile content')])('redacts pre-commit persistence failures', async (error) => {
    const { controller, network } = await bench()
    network!.save.mockRejectedValueOnce(error)
    await expect(controller.saveAndConnect(request, new AbortController().signal)).rejects.toMatchObject({ code: 'vpn/rejected',
      message: error instanceof NetworkError ? error.code : 'VPN_OPERATION_FAILED' })
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('does not reconnect when a newer disconnect arrives during persistence', async () => {
    const { controller, network } = await bench()
    const started = deferred()
    const release = deferred()
    network!.save.mockImplementationOnce(async () => { started.resolve(undefined); await release.promise })
    const save = controller.saveAndConnect(request, new AbortController().signal)
    await started.promise
    await controller.disconnect()
    release.resolve(undefined)
    await expect(save).resolves.toMatchObject({ connection: 'disconnected' })
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('does not reconnect when a newer disconnect arrives while replacing the tunnel', async () => {
    const { controller, network } = await bench()
    const started = deferred()
    const release = deferred()
    network!.disconnect.mockImplementationOnce(async () => { started.resolve(undefined); await release.promise })
    const connect = controller.connect()
    await started.promise
    await controller.disconnect()
    release.resolve(undefined)
    await connect
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('does not connect when cancelled after durable persistence', async () => {
    const { controller, network } = await bench()
    const abort = new AbortController()
    network!.save.mockImplementationOnce(async () => { abort.abort() })
    await controller.saveAndConnect(request, abort.signal)
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('refuses cancelled reads and leaves cancelled connection commands without process changes', async () => {
    const { controller, network } = await bench()
    const abort = new AbortController()
    abort.abort()
    await expect(controller.get(abort.signal)).rejects.toMatchObject({ details: { code: 'VPN_OPERATION_CANCELLED' } })
    await controller.connect(abort.signal)
    await controller.disconnect(abort.signal)
    expect(network!.connect).not.toHaveBeenCalled()
    expect(network!.disconnect).not.toHaveBeenCalled()
  })

  it('does not start a replacement connection after cancellation while the old tunnel stops', async () => {
    const { controller, network } = await bench()
    const started = deferred()
    const release = deferred()
    const abort = new AbortController()
    network!.disconnect.mockImplementationOnce(async () => { started.resolve(undefined); await release.promise })
    const connect = controller.connect(abort.signal)
    await started.promise
    abort.abort()
    release.resolve(undefined)
    await connect
    expect(network!.connect).not.toHaveBeenCalled()
  })

  it('rechecks disconnect intent after the initial provider mutation finishes', async () => {
    const { controller, network, ctx } = await bench()
    network!.state = { ...view(), profileName: null }
    const started = deferred()
    const release = deferred()
    settings(ctx).mockImplementationOnce(async () => { started.resolve(undefined); await release.promise })
    const save = controller.saveAndConnect(request, new AbortController().signal)
    await started.promise
    await controller.disconnect()
    release.resolve(undefined)
    await save
    expect(network!.connect).not.toHaveBeenCalled()
  })
})
