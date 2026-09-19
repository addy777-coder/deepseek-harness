/** Native userspace VPN provider; model traffic never falls back to the Host network. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialKey, parseCredentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { NetworkError, NetworkService, type NetworkTarget, type NetworkTargetId, type SaveVpnRequest, type VpnSettingsView } from '@deepseek-ai/dsh-network'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import { ProxyAgent, fetch as proxyFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { z } from 'zod'
import { NativeSession, verifyExecutable, type NativeEvent } from './native.ts'
import { importProfile } from './profile.ts'
import type { Config, ResolvedSpec } from './types.ts'

export type { Config } from './types.ts'

const storedSchema = z.object({ version: z.literal(1), profileName: z.string().min(1),
  profileContent: z.string().min(1), username: z.string().min(1), password: z.string().min(1) })
type StoredVpn = z.infer<typeof storedSchema>
interface SavedSettings { credentialKey: string; autoConnect: boolean }
interface RegisteredTarget { readonly url: URL; readonly abort: AbortController }
interface ConnectionRun {
  readonly abort: AbortController
  readonly ready: ReturnType<typeof Promise.withResolvers<void>>
  readonly finished: ReturnType<typeof Promise.withResolvers<void>>
  session?: NativeSession
  dispatcher?: ProxyAgent
  failure?: string
}

const authenticationErrors = new Set(['AUTH_FAILED', 'AUTH_PENDING', 'CREDENTIALS_REJECTED', 'UNSUPPORTED_AUTHENTICATION', 'VPN_CREDENTIALS_MISSING'])
const fatalErrors = new Set(['CERT_VERIFY_FAIL', 'TLS_VERSION_MIN', 'TLS_ALERT_MISC', 'OPTIONS_ERROR',
  'PROFILE_REJECTED_BY_OPENVPN3', 'VPN_RUNTIME_MISSING', 'VPN_RUNTIME_INTEGRITY_FAILED',
  'VPN_NATIVE_PROTOCOL_INVALID', 'VPN_SHUTDOWN_FAILED'])

/**
 * Resolve local process paths and bounded deployment settings.
 * @param config - configured values before defaults.
 * @returns explicit inputs used by every subsequent operation.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  type Paths = Pick<Config, 'executablePath' | 'executableSha256' | 'dshHome'>
  // Schemastery supplies every numeric default before this typed execution spec is constructed.
  const resolved = OpenVpnNetwork.Config(config) as Paths & Required<Omit<Config, keyof Paths>>
  const { executablePath, executableSha256, dshHome, ...limits } = resolved
  if (limits.reconnectMaxDelayMs < limits.reconnectDelayMs) throw new NetworkError('VPN_SETTINGS_INVALID')
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const binary = process.platform === 'win32' ? 'dsh-vpn.exe' : 'dsh-vpn'
  return { ...limits,
    executablePath: resolve(executablePath ?? fileURLToPath(new URL(`../../../../native/vpn/dist/${platform}-${process.arch}/${binary}`, import.meta.url))),
    ...executableSha256 === undefined ? {} : { executableSha256 },
    cwd: resolveDshHome(dshHome),
  }
}

/** Credential-backed, single-profile OpenVPN provider for the distributed native targets. */
export class OpenVpnNetwork extends NetworkService {
  static inject = ['credentials', 'settings', 'subprocess']
  static Config: Schema<Config> = Schema.object({
    executablePath: Schema.string(), executableSha256: Schema.string(), dshHome: Schema.string(),
    connectTimeoutSeconds: Schema.number().min(1).max(300).step(1).default(60),
    shutdownGraceMs: Schema.number().min(100).max(60000).step(1).default(5000),
    reconnectDelayMs: Schema.number().min(100).max(300000).step(1).default(2000),
    reconnectMaxDelayMs: Schema.number().min(100).max(300000).step(1).default(30000),
    maxConnections: Schema.number().min(1).max(32).step(1).default(16),
    headerTimeoutMs: Schema.number().min(100).max(60000).step(1).default(5000),
    targetConnectTimeoutMs: Schema.number().min(100).max(300000).step(1).default(30000),
    pollIntervalMs: Schema.number().min(1).max(1000).step(1).default(10),
    maxPendingPacketBytes: Schema.number().min(65536).max(8388608).step(1).default(1048576),
    maxProfileBytes: Schema.number().min(1024).max(786432).step(1).default(524288),
  })

  private readonly spec: ResolvedSpec
  private readonly targets = new Map<NetworkTargetId, RegisteredTarget>()
  private readonly supported = this.supportsHost()
  private scope!: SettingsScope<SavedSettings>
  private appliedSettings: SavedSettings | undefined
  private stored: StoredVpn | undefined
  private view: VpnSettingsView
  private current: ConnectionRun | undefined
  private wanted = false
  private disposed = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private retryCount = 0
  private writes: Promise<void> = Promise.resolve()
  private changes: Promise<void> = Promise.resolve()
  private intent = 0
  private validation: NativeSession | undefined

  /**
   * @param ctx - local credentials, settings, and managed subprocess services.
   * @param config - native artifact location and resource limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.view = { supported: this.supported, profileName: null, username: '', passwordConfigured: false,
      autoConnect: false, connection: 'unconfigured', failure: null }
  }

  /** @returns whether the current Host can execute the bundled native helper. */
  protected supportsHost(): boolean {
    return (process.arch === 'x64' && ['win32', 'darwin', 'linux'].includes(process.platform))
      || (process.platform === 'darwin' && process.arch === 'arm64')
  }

  /** Initialize credential references before publishing the injectable service. */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.disposed = true
      await this.disconnect()
      await this.validation?.close()
      await this.writes
      await this.changes
      for (const target of this.targets.values()) target.abort.abort()
      this.targets.clear()
    }
    this.scope = this.ctx.settings.register('network-openvpn', Schema.object({
      credentialKey: Schema.string().default(''), autoConnect: Schema.boolean().default(false),
    }), { applies: 'live' })
    await this.reload()
    this.ctx.effect(() => this.scope.watch(() => this.refresh(false)))
    this.ctx.on('credentials/record-updated', (key) => {
      if (key === this.scope.get().credentialKey) void this.refresh(true)
    })
    if (this.supported && this.scope.get().autoConnect && this.stored) {
      void this.connect()
    }
  }

  get(): Promise<VpnSettingsView> { return Promise.resolve(this.view) }

  save(request: SaveVpnRequest, signal?: AbortSignal): Promise<void> {
    const next = this.writes.then(() => this.saveExclusive(request, signal))
    this.writes = next.catch(() => { /* The initiating Remote observes the failed write. */ })
    return next
  }

  async connect(): Promise<void> {
    const intent = ++this.intent
    this.wanted = true
    await this.writes
    if (!this.hasIntent(intent)) return
    if (!this.supported) { this.publish('error', 'VPN_PLATFORM_UNSUPPORTED'); return }
    this.cancelRetry()
    if (this.current) {
      if (!this.current.abort.signal.aborted) return this.current.ready.promise
      await this.current.finished.promise
      if (!this.hasIntent(intent)) return
    }
    return this.launch(false)
  }

  async disconnect(): Promise<void> {
    this.intent++
    this.wanted = false
    this.cancelRetry()
    const run = this.current
    if (run) {
      run.abort.abort()
      if (run.session) await run.session.close()
      await run.finished.promise
    }
    this.retryCount = 0
    this.publish(this.stored ? 'disconnected' : 'unconfigured')
  }

  registerTarget(id: NetworkTargetId, target: NetworkTarget): () => void {
    if (this.targets.has(id)) throw new NetworkError('VPN_TARGET_DUPLICATE')
    if (this.targets.size >= 64 || this.disposed) throw new NetworkError('VPN_TARGET_UNAVAILABLE')
    const url = new URL(target.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new NetworkError('VPN_TARGET_INVALID')
    }
    const entry = { url, abort: new AbortController() }
    this.targets.set(id, entry)
    this.targetsChanged()
    return () => {
      if (this.targets.get(id) !== entry) return
      entry.abort.abort()
      this.targets.delete(id)
      this.targetsChanged()
    }
  }

  async fetch(id: NetworkTargetId, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const target = this.targets.get(id)
    if (!target) throw new NetworkError('VPN_TARGET_NOT_REGISTERED')
    const request = new Request(input, init)
    const url = new URL(request.url)
    const root = target.url.pathname.replace(/\/+$/u, '')
    if (url.origin !== target.url.origin || url.username || url.password
      || (root && url.pathname !== root && !url.pathname.startsWith(`${root}/`))) throw new NetworkError('VPN_TARGET_REJECTED')
    const run = this.current
    if (!run?.dispatcher || run.abort.signal.aborted || this.view.connection !== 'connected') throw new NetworkError('VPN_NOT_CONNECTED')
    const signal = AbortSignal.any([request.signal, run.abort.signal, target.abort.signal])
    const headers = new Headers(request.headers)
    headers.delete('proxy-authorization')
    headers.delete('host')
    try {
      const result = await proxyFetch(url, { method: request.method, headers: Object.fromEntries(headers),
        // Node Fetch and undici use the same WHATWG streams at runtime; their declarations come from separate libraries.
        ...request.body === null ? {} : { body: request.body as NonNullable<UndiciRequestInit['body']> },
        // proxy-exempt: Selected VPN requests require the authenticated application tunnel, with no host-proxy fallback.
        duplex: 'half', signal, redirect: 'error', dispatcher: run.dispatcher })
      return new Response(result.body as ReadableStream<Uint8Array> | null, {
        status: result.status, statusText: result.statusText, headers: Object.fromEntries(result.headers),
      })
    } catch {
      if (signal.aborted) throw new DOMException('VPN request aborted', 'AbortError')
      throw new NetworkError('VPN_REQUEST_FAILED')
    }
  }

  private async saveExclusive(request: SaveVpnRequest, signal?: AbortSignal): Promise<void> {
    if (!this.supported) throw new NetworkError('VPN_PLATFORM_UNSUPPORTED')
    this.assertSaveActive(signal)
    if (!request.username.trim() || /[\0\r\n]/u.test(request.username)) throw new NetworkError('VPN_CREDENTIALS_MISSING')
    const password = request.password ?? this.stored?.password
    if (!password || /[\0\r\n]/u.test(password)) throw new NetworkError('VPN_CREDENTIALS_MISSING')
    const profileContent = request.profile
      ? importProfile(request.profile, request.files ?? [], this.spec.maxProfileBytes) : this.stored?.profileContent
    const profileName = request.profile?.name ?? this.stored?.profileName
    if (!profileContent || !profileName) throw new NetworkError('VPN_PROFILE_MISSING')
    await mkdir(this.spec.cwd, { recursive: true })
    await verifyExecutable(this.spec)
    const validation = new NativeSession(this.ctx.subprocess, this.spec, { profileContent, evaluateOnly: true }, () => {})
    this.validation = validation
    const abort = () => { void validation.close() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await validation.evaluated()
      if (result.requiresChallenge || result.requiresPrivateKeyPassword || result.requiresExternalPki) throw new NetworkError('VPN_AUTHENTICATION_UNSUPPORTED')
    } finally { signal?.removeEventListener('abort', abort); this.validation = undefined }
    this.assertSaveActive(signal)
    await this.disconnect()
    this.assertSaveActive(signal)
    const previous = this.scope.get().credentialKey
    const key = credentialKey('network-openvpn', `profile-${randomUUID()}`)
    const next: StoredVpn = { version: 1, profileName, profileContent, username: request.username, password }
    await this.ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: next }))
    const previousApplied = this.appliedSettings
    this.appliedSettings = { credentialKey: String(key), autoConnect: request.autoConnect }
    try { await this.scope.update({ credentialKey: key, autoConnect: request.autoConnect }) }
    catch (error) { this.appliedSettings = previousApplied; await this.ctx.credentials.deleteRecord(key); throw error }
    this.stored = next
    this.publish('disconnected')
    if (previous) {
      try { await this.ctx.credentials.deleteRecord(this.ownedKey(previous)) }
      catch { this.ctx.logger.warn('VPN obsolete credential record cleanup failed') }
    }
  }

  private ownedKey(value: string): CredentialKey {
    const key = parseCredentialKey(value)
    if (!String(key).startsWith('network-openvpn/')) throw new NetworkError('VPN_CREDENTIAL_REFERENCE_INVALID')
    return key
  }

  private async reload(): Promise<void> {
    const saved = this.scope.get()
    this.appliedSettings = saved
    this.stored = undefined
    try {
      if (saved.credentialKey) {
        const record = await this.ctx.credentials.readRecord(this.ownedKey(saved.credentialKey))
        if (record?.kind !== 'grant') throw new NetworkError('VPN_CREDENTIALS_MISSING')
        const parsed = storedSchema.safeParse(record.payload)
        if (!parsed.success) throw new NetworkError('VPN_CREDENTIAL_RECORD_INVALID')
        this.stored = parsed.data
      }
    } catch (error) {
      this.publish('error', error instanceof NetworkError ? error.code : 'VPN_CREDENTIAL_RECORD_INVALID')
      return
    }
    this.publish(this.stored ? 'disconnected' : 'unconfigured')
  }

  private refresh(force: boolean): Promise<void> {
    const operation = this.changes.then(async () => {
      await this.writes
      if (this.disposed) return
      const next = this.scope.get()
      if (!force && this.appliedSettings?.credentialKey === next.credentialKey
        && this.appliedSettings.autoConnect === next.autoConnect) return
      const resume = this.wanted || next.autoConnect
      const stopped = this.disconnect()
      const intent = this.intent
      await stopped
      await this.reload()
      if (resume && this.stored && this.hasIntent(intent)) void this.connect()
    })
    this.changes = operation.catch(() => { this.publish('error', 'VPN_OPERATION_FAILED') })
    return this.changes
  }

  private publish(connection: VpnSettingsView['connection'], code?: string): void {
    this.view = { supported: this.supported, profileName: this.stored?.profileName ?? null,
      username: this.stored?.username ?? '', passwordConfigured: !!this.stored?.password,
      autoConnect: this.appliedSettings?.autoConnect ?? false, connection, failure: code ? { code } : null }
    if (this.disposed) return
    const published = this.view
    for (const listener of this.ctx.events.dispatch('emit', ['network/changed', published]) as Array<(view: VpnSettingsView) => unknown>) {
      try {
        void Promise.resolve(listener(published)).catch(() => { this.ctx.logger.warn('VPN status listener failed') })
      } catch { this.ctx.logger.warn('VPN status listener failed') }
    }
  }

  private launch(reconnecting: boolean): Promise<void> {
    if (this.current) return this.current.ready.promise
    const run: ConnectionRun = { abort: new AbortController(), ready: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>() }
    this.current = run
    this.publish(reconnecting ? 'reconnecting' : 'connecting')
    void this.run(run).finally(() => { run.ready.resolve(); run.finished.resolve() })
    return run.ready.promise
  }

  private async run(run: ConnectionRun): Promise<void> {
    let failure: string | undefined
    try {
      const stored = this.stored
      if (!stored) throw new NetworkError('VPN_CREDENTIALS_MISSING')
      await mkdir(this.spec.cwd, { recursive: true })
      await verifyExecutable(this.spec)
      if (this.runCancelled(run)) return
      const proxyToken = randomBytes(32).toString('hex')
      const targets = [...new Map([...this.targets.values()].map(({ url }) => {
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
        return [`${url.hostname}:${port}`, { host: url.hostname, port }]
      })).values()]
      const { connectTimeoutSeconds, maxConnections, headerTimeoutMs,
        targetConnectTimeoutMs, pollIntervalMs, maxPendingPacketBytes } = this.spec
      const session = new NativeSession(this.ctx.subprocess, this.spec, {
        connectTimeoutSeconds, maxConnections, headerTimeoutMs, targetConnectTimeoutMs, pollIntervalMs, maxPendingPacketBytes,
        profileContent: stored.profileContent,
        username: stored.username, password: stored.password, targets, proxyToken }, (event) => { this.nativeEvent(run, event) })
      run.session = session
      const port = await session.ready
      if (this.runCancelled(run)) return
      // proxy-exempt: This agent reaches only the owned loopback VPN helper and must ignore unrelated proxy settings.
      run.dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${port}`, token: `Bearer ${proxyToken}` })
      this.retryCount = 0
      this.publish('connected')
      run.ready.resolve()
      await session.done
      if (!this.runCancelled(run)) throw new NetworkError(run.failure ?? 'VPN_CONNECTION_LOST')
    } catch (error) {
      if (!run.abort.signal.aborted) {
        failure = run.failure ?? (error instanceof NetworkError ? error.code : 'VPN_CONNECTION_FAILED')
        this.publish('error', failure)
      }
    } finally {
      run.abort.abort()
      const cleanup = await Promise.allSettled([run.dispatcher?.destroy(), run.session?.close()])
      if (cleanup.some(result => result.status === 'rejected')) {
        failure = 'VPN_SHUTDOWN_FAILED'; this.publish('error', failure)
      }
      this.current = undefined
      if (failure !== undefined && this.wanted && !this.disposed) this.scheduleReconnect(failure)
    }
  }

  private nativeEvent(run: ConnectionRun, event: NativeEvent): void {
    if (event.error && event.event !== 'connection-failed') run.failure = event.event
  }

  private hasIntent(intent: number): boolean { return !this.disposed && intent === this.intent }

  private runCancelled(run: ConnectionRun): boolean { return run.abort.signal.aborted }

  private assertSaveActive(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new NetworkError('VPN_OPERATION_CANCELLED')
  }

  private scheduleReconnect(code: string): void {
    if (authenticationErrors.has(code) || fatalErrors.has(code)
      || /^(?:UNSUPPORTED_|INVALID_|PROFILE_|BOOTSTRAP_|VPN_PROFILE_)/u.test(code)) {
      this.wanted = false
      return
    }
    const delay = Math.min(this.spec.reconnectMaxDelayMs, this.spec.reconnectDelayMs * 2 ** Math.min(this.retryCount++, 16))
    this.publish('reconnecting', code)
    this.retry = setTimeout(() => { this.retry = undefined; void this.launch(true) }, delay)
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) clearTimeout(this.retry)
    this.retry = undefined
  }

  private targetsChanged(): void {
    const run = this.current
    if (!run || !this.wanted || this.disposed) return
    run.abort.abort()
    if (run.session) void run.session.close()
    void run.finished.promise.then(() => { if (this.wanted && !this.disposed) void this.launch(true) })
  }
}

export default OpenVpnNetwork
