import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { networkTargetId, type SaveVpnRequest } from '@deepseek-ai/dsh-network'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { OpenVpnNetwork, resolveSpec } from '../src/index.ts'
import * as native from '../src/native.ts'

class Helper implements SubprocessHandle {
  readonly pid = 1
  readonly control = undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly collected = {}
  readonly exit = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.exit.promise
  readonly closed = Promise.withResolvers<undefined>()
  bootstrap: Record<string, unknown> = {}
  shutdown: (() => void) | undefined
  terminated = false
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.bootstrap = JSON.parse(chunk.toString()) as Record<string, unknown>
      queueMicrotask(() =>{  this.start(this) })
      callback()
    },
    final: (callback) => { this.closed.resolve(undefined); if (this.shutdown) this.shutdown(); else this.finish(); callback() },
  })
  constructor(readonly spec: SubprocessSpawnSpec, readonly start: (helper: Helper) => void) {}
  event(value: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify(value)}\n`) }
  finish(code = 0): void { this.stdout.end(); this.stderr.end(); this.exit.resolve({ exitCode: code, signal: null }) }
  terminate(): void { this.terminated = true; this.finish(1) }
  async waitForExit(): Promise<boolean> { await this.done; return true }
}

class Processes extends SubprocessRuntime {
  readonly children: Helper[] = []
  onConnect: (helper: Helper) => void = (helper) =>{  helper.event({ event: 'proxy-ready', port: 23456, error: false }) }
  onEvaluate: (helper: Helper) => void = (helper) => {
    helper.event({ event: 'profile-evaluated', accepted: true }); helper.finish()
  }
  async resolveExecutable(command: string): Promise<string> { return command }
  async terminalEnvironment(): Promise<never> { throw new Error('No terminal environment in the VPN process fixture') }
  async spawnTerminal(): Promise<never> { throw new Error('No terminals in the VPN protocol') }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const helper = new Helper(spec, (child) => {
      if (child.bootstrap.evaluateOnly === true) this.onEvaluate(child)
      else this.onConnect(child)
    })
    this.children.push(helper)
    return helper
  }
}

class PortableNetwork extends OpenVpnNetwork {
  protected override supportsHost(): boolean { return true }
}
class UnsupportedNetwork extends OpenVpnNetwork {
  protected override supportsHost(): boolean { return false }
}
class HostProbe extends OpenVpnNetwork {
  static supported(): boolean { return this.prototype.supportsHost() }
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const request: SaveVpnRequest = { profile: { name: 'company.ovpn', content: 'client\nauth-user-pass\nremote vpn.example 1194\n' },
  username: 'employee', password: 'vpn-test-secret', autoConnect: true }
const key = credentialKey('network-openvpn', 'test')
const stored = { version: 1, profileName: 'company.ovpn', profileContent: request.profile!.content,
  username: request.username, password: request.password! }

async function harness(options: { saved?: boolean; autoConnect?: boolean; unsupported?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-provider-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const executablePath = join(directory, 'helper.exe')
  await writeFile(executablePath, 'fixture-native-image')
  const executableSha256 = createHash('sha256').update('fixture-native-image').digest('hex')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemoryCredentials)
  if (options.saved) await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: stored }))
  await ctx.plugin(MemorySettings, { doc: options.saved
    ? { 'network-openvpn': { credentialKey: key, autoConnect: options.autoConnect ?? false } } : {} })
  await ctx.plugin(Processes)
  const fiber = await ctx.plugin(options.unsupported ? UnsupportedNetwork : PortableNetwork, {
    executablePath, executableSha256, dshHome: directory, shutdownGraceMs: 100,
    reconnectDelayMs: 100, reconnectMaxDelayMs: 200,
  })
  return { ctx, fiber, network: ctx.network, processes: ctx.subprocess as Processes, directory }
}

describe('VPN provider configuration and lifetime', () => {
  it('validates limits before starting processes', () => {
    expect(() => resolveSpec({ maxConnections: 33 })).toThrow()
    expect(() => resolveSpec({ reconnectDelayMs: 200, reconnectMaxDelayMs: 100 })).toThrow()
    expect(resolveSpec({})).toMatchObject({ connectTimeoutSeconds: 60, maxConnections: 16 })
  })

  it('selects the distributed helper for each supported host and rejects other targets', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
    try {
      for (const [hostPlatform, hostArch, supported] of [
        ['win32', 'x64', true], ['darwin', 'x64', true], ['darwin', 'arm64', true], ['linux', 'x64', true],
        ['win32', 'arm64', false], ['linux', 'arm64', false], ['freebsd', 'x64', false], ['linux', 'ia32', false],
      ] as const) {
        Object.defineProperty(process, 'platform', { value: hostPlatform })
        Object.defineProperty(process, 'arch', { value: hostArch })
        expect(HostProbe.supported()).toBe(supported)
        if (supported) {
          const directory = `${hostPlatform === 'win32' ? 'windows' : hostPlatform}-${hostArch}`
          const binary = hostPlatform === 'win32' ? 'dsh-vpn.exe' : 'dsh-vpn'
          expect(resolveSpec({}).executablePath.replaceAll('\\', '/')).toContain(`/native/vpn/dist/${directory}/${binary}`)
        }
      }
    } finally { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch) }
  })

  it('cleans up partial initialization when the stored settings schema is invalid', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings, { doc: { 'network-openvpn': { credentialKey: 42 } } })
    await ctx.plugin(Processes)
    await expect(ctx.plugin(PortableNetwork)).rejects.toThrow()
    expect((ctx.subprocess as Processes).children).toEqual([])
  })

  it('rejects empty or multiline credentials before profile evaluation', async () => {
    const { network, processes } = await harness()
    for (const values of [{ username: ' ' }, { username: 'name\nother' }, { password: '' }, { password: 'p\rvalue' }]) {
      await expect(network.save({ ...request, ...values })).rejects.toMatchObject({ code: 'VPN_CREDENTIALS_MISSING' })
    }
    await expect(network.save({ username: 'employee', autoConnect: false })).rejects.toMatchObject({ code: 'VPN_CREDENTIALS_MISSING' })
    expect(processes.children).toEqual([])
    await network.connect()
    expect(await network.get()).toMatchObject({ connection: 'error', failure: { code: 'VPN_CREDENTIALS_MISSING' } })
  })

  it('enforces unique target identifiers, valid model origins and the native target limit', async () => {
    const { network, fiber } = await harness()
    const id = networkTargetId('first')
    const revoke = network.registerTarget(id, { baseURL: 'http://models.example' })
    expect(() => network.registerTarget(id, { baseURL: 'http://models.example' })).toThrow('VPN_TARGET_DUPLICATE')
    for (const baseURL of ['ftp://models.example', 'https://user@models.example', 'https://user:pass@models.example', 'https://models.example?x=1', 'https://models.example#fragment']) {
      expect(() => network.registerTarget(networkTargetId(baseURL), { baseURL })).toThrow('VPN_TARGET_INVALID')
    }
    revoke(); revoke()
    for (let index = 0; index < 64; index++) network.registerTarget(networkTargetId(String(index)), { baseURL: 'http://models.example' })
    expect(() => network.registerTarget(id, { baseURL: 'http://models.example' })).toThrow('VPN_TARGET_UNAVAILABLE')
    await fiber.dispose()
    expect(() => network.registerTarget(id, { baseURL: 'http://models.example' })).toThrow('VPN_TARGET_UNAVAILABLE')
  })

  it('retains the new settings when obsolete credential cleanup fails', async () => {
    const { ctx, network } = await harness({ saved: true })
    const original = ctx.credentials.deleteRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'deleteRecord').mockImplementation(value => value === key ? Promise.reject(new Error('storage failed')) : original(value))
    await network.save({ ...request, username: 'replacement' })
    expect(await network.get()).toMatchObject({ username: 'replacement', passwordConfigured: true })
    expect(await ctx.credentials.listRecords()).toHaveLength(2)
  })

  it('rejects unavailable native files before saving or launching', async () => {
    const { network, directory, processes } = await harness({ saved: true })
    await rm(join(directory, 'helper.exe'))
    await expect(network.save(request)).rejects.toMatchObject({ code: 'VPN_RUNTIME_MISSING' })
    await network.connect()
    expect(await network.get()).toMatchObject({ connection: 'error', failure: { code: 'VPN_RUNTIME_MISSING' } })
    expect(processes.children).toEqual([])
  })

  it('keeps unrelated, absent and unreadable credential references repairable', async () => {
    const { ctx, network } = await harness({ saved: true })
    const settings = ctx.settings as MemorySettings
    settings.pushExternal({ 'network-openvpn': { credentialKey: 'pi-ai/other', autoConnect: false } })
    await vi.waitFor(async () => { expect((await network.get()).failure?.code).toBe('VPN_CREDENTIAL_REFERENCE_INVALID') })
    settings.pushExternal({ 'network-openvpn': { credentialKey: 'invalid', autoConnect: false } })
    await vi.waitFor(async () => { expect((await network.get()).failure?.code).toBe('VPN_CREDENTIAL_RECORD_INVALID') })
    settings.pushExternal({ 'network-openvpn': { credentialKey: 'network-openvpn/absent', autoConnect: false } })
    await vi.waitFor(async () => { expect((await network.get()).failure?.code).toBe('VPN_CREDENTIALS_MISSING') })
    settings.pushExternal({ 'network-openvpn': { credentialKey: '', autoConnect: false } })
    await vi.waitFor(async () => { expect((await network.get()).connection).toBe('unconfigured') })
  })

  it('reloads changed settings and credentials while preserving the connection intent', async () => {
    const { ctx, network, processes } = await harness({ saved: true })
    ;(ctx.settings as MemorySettings).pushExternal({ 'network-openvpn': { credentialKey: key, autoConnect: true } })
    await vi.waitFor(async () => { expect((await network.get()).connection).toBe('connected') })
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { ...stored, password: 'new-password' } }))
    await vi.waitFor(() => { expect(processes.children).toHaveLength(2) })
    await vi.waitFor(async () => { expect((await network.get()).connection).toBe('connected') })
    expect(processes.children[1]!.bootstrap.password).toBe('new-password')
    ;(ctx.settings as MemorySettings).pushExternal({ 'network-openvpn': { credentialKey: key, autoConnect: true } })
    await ctx.credentials.modifyRecord(credentialKey('other', 'unrelated'), async () => ({ kind: 'grant', payload: {} }))
    await network.connect()
    expect(processes.children).toHaveLength(2)
  })

  it('contains failing status observers while publishing every connection state', async () => {
    const { ctx, network } = await harness({ saved: true })
    const observed: string[] = []
    ctx.on('network/changed', () => { throw new Error('observer failed') })
    // oxlint-disable-next-line typescript/no-misused-promises -- A plugin can reject through the synchronous event API.
    ctx.on('network/changed', () => Promise.reject(new Error('async observer failed')))
    ctx.on('network/changed', (view) => { observed.push(view.connection) })
    await network.connect()
    await network.disconnect()
    expect(observed).toContain('connected')
    expect(observed.at(-1)).toBe('disconnected')
  })

  it('coalesces simultaneous connects and cancels a connect superseded while saving', async () => {
    const { network, processes } = await harness({ saved: true })
    await Promise.all([network.connect(), network.connect()])
    expect(processes.children).toHaveLength(1)
    const evaluating = Promise.withResolvers<Helper>()
    processes.onEvaluate = (child) => { evaluating.resolve(child) }
    const save = network.save(request)
    const validation = await evaluating.promise
    const connect = network.connect()
    await network.disconnect()
    validation.event({ event: 'profile-evaluated', accepted: true }); validation.finish()
    await Promise.all([save, connect])
    expect((await network.get()).connection).toBe('disconnected')
    expect(processes.children).toHaveLength(2)
  })

  it('cancels profile validation and prevents writes after disposal', async () => {
    const { ctx, network, processes, fiber } = await harness({ saved: true })
    const evaluating = Promise.withResolvers<Helper>()
    processes.onEvaluate = (child) => { evaluating.resolve(child) }
    const abort = new AbortController()
    const save = network.save(request, abort.signal)
    const rejected = expect(save).rejects.toThrow()
    const helper = await evaluating.promise
    abort.abort()
    await rejected
    expect(await helper.done).toMatchObject({ exitCode: 0 })
    expect(await ctx.credentials.listRecords()).toHaveLength(1)
    await fiber.dispose()
    await expect(network.save(request)).rejects.toMatchObject({ code: 'VPN_OPERATION_CANCELLED' })
    await network.connect()
    expect(processes.children).toHaveLength(1)
  })

  it('lets a newer disconnect win while a replacement connection waits for old shutdown', async () => {
    const { network, processes } = await harness({ saved: true })
    await network.connect()
    const child = processes.children[0]!
    child.shutdown = () => {}
    const revoke = network.registerTarget(networkTargetId('new'), { baseURL: 'http://models.example' })
    await child.closed.promise
    const connect = network.connect()
    await Promise.resolve()
    const disconnect = network.disconnect()
    child.finish()
    await Promise.all([connect, disconnect])
    expect(processes.children).toHaveLength(1)
    expect((await network.get()).connection).toBe('disconnected')
    revoke()
  })

  it('does not reconnect when process-tree cleanup cannot complete', async () => {
    const { network, processes } = await harness({ saved: true })
    await network.connect()
    const child = processes.children[0]!
    vi.spyOn(child, 'waitForExit').mockRejectedValue(new Error('process tree failed'))
    child.finish(1)
    await vi.waitFor(async () => { expect((await network.get()).failure?.code).toBe('VPN_SHUTDOWN_FAILED') })
    expect(processes.children).toHaveLength(1)
  })

  it('replaces a draining helper after an explicit reconnect and deduplicates target origins', async () => {
    const { network, processes } = await harness({ saved: true })
    await network.connect()
    const child = processes.children[0]!
    child.shutdown = () => {}
    network.registerTarget(networkTargetId('one'), { baseURL: 'http://models.example/api' })
    network.registerTarget(networkTargetId('two'), { baseURL: 'http://models.example/other' })
    await child.closed.promise
    const connect = network.connect()
    await Promise.resolve()
    child.finish()
    await connect
    await vi.waitFor(async () => { expect((await network.get()).connection).toBe('connected') })
    expect(processes.children).toHaveLength(2)
    expect(processes.children[1]!.bootstrap.targets).toEqual([{ host: 'models.example', port: 80 }])
  })

  it('cancels a helper before verified native code can start', async () => {
    const { network, processes } = await harness({ saved: true })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const verify = native.verifyExecutable
    vi.spyOn(native, 'verifyExecutable').mockImplementation(async (spec) => { entered.resolve(undefined); await release.promise; await verify(spec) })
    const connect = network.connect()
    await entered.promise
    network.registerTarget(networkTargetId('pending-verification'), { baseURL: 'https://models.example' })
    const disconnect = network.disconnect()
    release.resolve(undefined)
    await Promise.all([connect, disconnect])
    expect(processes.children).toEqual([])
    expect((await network.get()).connection).toBe('disconnected')
  })

  it('ignores late readiness after disconnect and aborts an unfinished handshake', async () => {
    const { network, processes } = await harness({ saved: true })
    const started = Promise.withResolvers<Helper>()
    processes.onConnect = (child) => { started.resolve(child) }
    const connecting = network.connect()
    const child = await started.promise
    child.event({ event: 'proxy-ready', port: 23456 })
    await network.disconnect()
    await connecting
    expect((await network.get()).connection).toBe('disconnected')
    const secondStarted = Promise.withResolvers<Helper>()
    processes.onConnect = (second) => { secondStarted.resolve(second) }
    const secondConnect = network.connect()
    await secondStarted.promise
    await network.disconnect()
    await secondConnect
    expect((await network.get()).connection).toBe('disconnected')
  })

  it('contains storage refresh failures without leaving a live helper', async () => {
    const { ctx, network, processes } = await harness({ saved: true })
    await network.connect()
    const child = processes.children[0]!
    vi.spyOn(child, 'waitForExit').mockRejectedValue(new Error('tree wait failed'))
    ;(ctx.settings as MemorySettings).pushExternal({ 'network-openvpn': { credentialKey: key, autoConnect: true } })
    await vi.waitFor(async () => { expect((await network.get()).failure?.code).toBe('VPN_OPERATION_FAILED') })
    expect(await child.done).toMatchObject({ exitCode: 0 })
  })

  it('drops a queued credential refresh when the provider is disposed during a save', async () => {
    const { ctx, network, processes, fiber } = await harness({ saved: true })
    const entered = Promise.withResolvers<Helper>()
    processes.onEvaluate = (child) => { entered.resolve(child) }
    const save = network.save(request)
    const rejected = expect(save).rejects.toThrow()
    await entered.promise
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { ...stored, password: 'external-change' } }))
    await fiber.dispose()
    await rejected
    expect(processes.children).toHaveLength(1)
  })

  it('redacts subprocess spawn failures and allows a manual disconnect to cancel retries', async () => {
    const { network, processes } = await harness({ saved: true })
    vi.spyOn(processes, 'spawn').mockImplementation(() => { throw new Error('sensitive spawn details') })
    await network.connect()
    expect(await network.get()).toMatchObject({ connection: 'reconnecting', failure: { code: 'VPN_CONNECTION_FAILED' } })
    expect(JSON.stringify(await network.get())).not.toContain('sensitive')
    await network.disconnect()
    expect((await network.get()).connection).toBe('disconnected')
  })

  it('stores secrets only in one credential record and preserves an omitted password', async () => {
    const { ctx, network, processes } = await harness()
    await network.save(request)
    expect(await network.get()).toMatchObject({ profileName: 'company.ovpn', passwordConfigured: true, connection: 'disconnected' })
    expect(JSON.stringify(ctx.settings.describe())).not.toContain('vpn-test-secret')
    const first = await ctx.credentials.listRecords()
    expect(first).toHaveLength(1)
    await network.save({ username: 'updated', autoConnect: false })
    expect(await ctx.credentials.readRecord(first[0]!.key)).toBeUndefined()
    const records = await ctx.credentials.listRecords()
    expect(await ctx.credentials.readRecord(records[0]!.key)).toMatchObject({ payload: { password: 'vpn-test-secret', username: 'updated' } })
    expect(JSON.stringify(processes.children.map(child => child.spec))).not.toContain('vpn-test-secret')
    expect(JSON.stringify(await network.get())).not.toContain('vpn-test-secret')
  })

  it('rolls back the new credential when settings persistence rejects', async () => {
    const { ctx, network } = await harness()
    ;(ctx.settings as MemorySettings).writableFlag = false
    await expect(network.save(request)).rejects.toThrow()
    expect(await ctx.credentials.listRecords()).toEqual([])
    expect(await network.get()).toMatchObject({ profileName: null })
  })

  it('starts saved automatic connections and drains owned helpers on disposal', async () => {
    const { network, processes, fiber } = await harness({ saved: true, autoConnect: true })
    await vi.waitFor(async () =>{  expect((await network.get()).connection).toBe('connected') })
    const helper = processes.children[0]!
    expect(helper.bootstrap).toMatchObject({ targets: [], username: 'employee', maxConnections: 16 })
    expect(helper.bootstrap).not.toHaveProperty('cwd')
    await fiber.dispose()
    expect(await helper.done).toMatchObject({ exitCode: 0 })
    expect(helper.terminated).toBe(false)
  })

  it('rejects missing profiles, incomplete imports, unsupported authentication and unavailable platforms', async () => {
    const { network, processes } = await harness()
    await expect(network.save({ username: 'u', password: 'p', autoConnect: false })).rejects.toMatchObject({ code: 'VPN_PROFILE_MISSING' })
    await expect(network.save({ ...request, profile: { name: 'missing.ovpn', content: 'ca missing.pem' } })).rejects.toMatchObject({ code: 'VPN_PROFILE_REFERENCE_MISSING' })
    processes.onEvaluate = (child) => { child.event({ event: 'profile-evaluated', accepted: true, requiresChallenge: true }); child.finish() }
    await expect(network.save(request)).rejects.toMatchObject({ code: 'VPN_AUTHENTICATION_UNSUPPORTED' })
    const unsupported = await harness({ unsupported: true })
    await expect(unsupported.network.save(request)).rejects.toMatchObject({ code: 'VPN_PLATFORM_UNSUPPORTED' })
    await unsupported.network.connect()
    expect(await unsupported.network.get()).toMatchObject({ supported: false, failure: { code: 'VPN_PLATFORM_UNSUPPORTED' } })
  })

  it('keeps corrupt saved credentials repairable from settings', async () => {
    const { ctx, network } = await harness({ saved: true })
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { version: 99 } }))
    await vi.waitFor(async () =>{  expect((await network.get()).failure?.code).toBe('VPN_CREDENTIAL_RECORD_INVALID') })
    await network.save(request)
    expect((await network.get()).passwordConfigured).toBe(true)
  })

  it('cancels saving before persistence while the previous helper drains', async () => {
    const { ctx, network, processes } = await harness({ saved: true })
    await network.connect()
    const helper = processes.children[0]!
    helper.shutdown = () => {}
    const abort = new AbortController()
    const save = network.save({ ...request, password: 'replacement-secret' }, abort.signal)
    await helper.closed.promise
    abort.abort()
    helper.finish()
    await expect(save).rejects.toMatchObject({ code: 'VPN_OPERATION_CANCELLED' })
    expect(await ctx.credentials.readRecord(key)).toMatchObject({ payload: { password: 'vpn-test-secret' } })
  })

  it('lets a newer disconnect win while externally changed credentials are loading', async () => {
    const { ctx, network, processes } = await harness({ saved: true })
    await network.connect()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.credentials.readRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async (value) => { entered.resolve(undefined); await release.promise; return original(value) })
    await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { ...stored, password: 'changed' } }))
    await entered.promise
    await network.disconnect()
    release.resolve(undefined)
    await vi.waitFor(async () =>{  expect((await network.get()).connection).toBe('disconnected') })
    await network.get()
    expect(processes.children).toHaveLength(1)
  })

  it('stops retries for authentication and malformed protocol failures', async () => {
    const { network, processes } = await harness({ saved: true })
    await network.connect()
    vi.useFakeTimers()
    processes.children[0]!.stdout.write('not-json\n')
    await vi.waitFor(async () =>{  expect((await network.get()).failure?.code).toBe('VPN_NATIVE_PROTOCOL_INVALID') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(processes.children).toHaveLength(1)
    vi.useRealTimers()
    processes.onConnect = (child) =>{  child.event({ event: 'AUTH_FAILED', error: true }) }
    await network.connect()
    expect((await network.get()).failure?.code).toBe('AUTH_FAILED')
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(1000)
    expect(processes.children).toHaveLength(2)
  })

  it('reconnects lost networks and restarts with revised allowlists', async () => {
    const { network, processes } = await harness({ saved: true })
    const id = networkTargetId('company')
    const revoke = network.registerTarget(id, { baseURL: 'https://models.example/api' })
    await network.connect()
    expect(processes.children[0]!.bootstrap.targets).toEqual([{ host: 'models.example', port: 443 }])
    processes.children[0]!.finish(1)
    await vi.waitFor(() =>{  expect(processes.children).toHaveLength(2) })
    revoke()
    await vi.waitFor(() =>{  expect(processes.children).toHaveLength(3) })
    await vi.waitFor(async () =>{  expect((await network.get()).connection).toBe('connected') })
    expect(processes.children[2]!.bootstrap.targets).toEqual([])
    await network.disconnect()
    await expect(network.fetch(id, 'https://models.example/api/messages')).rejects.toMatchObject({ code: 'VPN_TARGET_NOT_REGISTERED' })
  })
})

describe('VPN streaming request isolation', () => {
  it('uses authenticated CONNECT, preserves streams and refuses destinations or direct fallback', async () => {
    const sockets = new Set<Duplex>()
    let waiting = Promise.withResolvers<undefined>()
    const observedHeaders: Array<{ host: string | undefined; proxy: string | string[] | undefined }> = []
    const upstream = createHttpServer((req, res) => {
      observedHeaders.push({ host: req.headers.host, proxy: req.headers['proxy-authorization'] })
      if (req.url === '/v1/pending') { waiting.resolve(undefined); return }
      if (req.url === '/v1/redirect') { res.writeHead(302, { location: 'https://unconfigured.example' }); res.end(); return }
      if (req.url === '/v1') { res.writeHead(204); res.end(); return }
      res.setHeader('content-type', 'text/event-stream')
      res.write('event: message_start\ndata: {}\n\n')
      res.end('event: message_stop\ndata: {}\n\n')
    })
    const proxy = createHttpServer()
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([
        new Promise<void>(resolve => upstream.close(() => { resolve() })),
        new Promise<void>(resolve => proxy.close(() => { resolve() })),
      ])
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const upstreamAddress = upstream.address()
    const proxyAddress = proxy.address()
    if (!upstreamAddress || typeof upstreamAddress === 'string' || !proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing fixture addresses')
    const { network, processes } = await harness({ saved: true })
    const id = networkTargetId('company')
    const baseURL = `http://127.0.0.1:${upstreamAddress.port}/v1`
    const revoke = network.registerTarget(id, { baseURL })
    const authenticated: boolean[] = []
    proxy.on('connect', (req, client, head) => {
      const token = processes.children.at(-1)!.bootstrap.proxyToken
      authenticated.push(req.headers['proxy-authorization'] === `Bearer ${String(token)}`)
      expect(req.url).toBe(`127.0.0.1:${upstreamAddress.port}`)
      sockets.add(client)
      const server = connectTcp(upstreamAddress.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) server.write(head)
        client.pipe(server).pipe(client)
      })
      client.on('error', () => { server.destroy() })
      server.on('error', () => { client.destroy() })
      sockets.add(server)
    })
    processes.onConnect = (helper) =>{  helper.event({ event: 'proxy-ready', port: proxyAddress.port }) }
    await expect(network.fetch(id, `${baseURL}/messages`)).rejects.toMatchObject({ code: 'VPN_NOT_CONNECTED' })
    await network.connect()
    const response = await network.fetch(id, `${baseURL}/messages`, { method: 'POST', body: '{}',
      headers: { 'proxy-authorization': 'untrusted-caller-value', host: 'unconfigured.example' } })
    expect(await response.text()).toContain('event: message_stop')
    expect(authenticated).toEqual([true])
    expect(observedHeaders[0]).toEqual({ host: `127.0.0.1:${upstreamAddress.port}`, proxy: undefined })
    expect((await network.fetch(id, baseURL)).status).toBe(204)
    await expect(network.fetch(id, `${baseURL}/redirect`)).rejects.toMatchObject({ code: 'VPN_REQUEST_FAILED' })
    await expect(network.fetch(id, 'https://unconfigured.example/messages')).rejects.toMatchObject({ code: 'VPN_TARGET_REJECTED' })
    await expect(network.fetch(id, `http://127.0.0.1:${upstreamAddress.port}/outside`)).rejects.toMatchObject({ code: 'VPN_TARGET_REJECTED' })
    const aborted = new AbortController()
    const callerPending = network.fetch(id, `${baseURL}/pending`, { signal: aborted.signal })
    const callerRejected = expect(callerPending).rejects.toMatchObject({ name: 'AbortError' })
    await waiting.promise
    aborted.abort()
    await callerRejected
    waiting = Promise.withResolvers<undefined>()
    const targetPending = network.fetch(id, `${baseURL}/pending`)
    const targetRejected = expect(targetPending).rejects.toMatchObject({ name: 'AbortError' })
    await waiting.promise
    revoke()
    await targetRejected
    network.registerTarget(id, { baseURL })
    await network.connect()
    waiting = Promise.withResolvers<undefined>()
    const disconnectPending = network.fetch(id, `${baseURL}/pending`)
    const disconnectRejected = expect(disconnectPending).rejects.toMatchObject({ name: 'AbortError' })
    await waiting.promise
    await network.disconnect()
    await disconnectRejected
    await expect(network.fetch(id, `${baseURL}/messages`)).rejects.toMatchObject({ code: 'VPN_NOT_CONNECTED' })
    expect(authenticated.every(value => value)).toBe(true)
  })
})
