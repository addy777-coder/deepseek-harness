import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import UsageController, * as UsageModule from '../src/index.ts'
import { event, header, message, NOW, turn, usage, user } from './helpers.ts'

const contexts: Context[] = []
const directories: string[] = []
const request = { days: 7, timeZone: 'UTC' } as const
const signal = (): AbortSignal => new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function harness(config = { concurrentReads: 4, cacheSize: 256 }, loader = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
  directories.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  const persistenceRoot = join(directory, 'sessions')
  let persistenceFiber: Fiber | undefined
  if (loader) {
    const configPath = join(directory, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      `  config: ${JSON.stringify({ root: persistenceRoot, compression: 'none' })}`,
      "- name: '@deepseek-ai/dsh-session-query-sqlite'",
      `  config: ${JSON.stringify({ path: ':memory:', openAt: 'never', preparedSessionCacheSize: 1 })}`,
      "- name: '@deepseek-ai/dsh-api-usage-controller'",
      `  config: ${JSON.stringify(config)}`,
      '',
    ].join('\n'))
    ctx.baseUrl = `${pathToFileURL(directory).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-session-query-sqlite', SessionQuery],
      ['@deepseek-ai/dsh-api-usage-controller', UsageModule],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
  } else {
    await ctx.plugin(SessionStore)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never', preparedSessionCacheSize: 1 })
  }
  const fiber = loader ? undefined : await ctx.plugin(UsageController, config)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  return { ctx, controller: ctx.usageController, directory, persistenceRoot, fiber, persistenceFiber }
}

async function persist(ctx: Context, meta: SessionHeader, events: readonly SessionEvent[], inherited = 0): Promise<void> {
  await using writer = await ctx.sessionPersistence.create(meta,
    meta.isSeeded ? { inheritedEventCount: SessionLogOffset(inherited) } : undefined)
  await writer.append(events.map((value, seq) => ({ ...value, seq: SessionSeq(seq) })))
}

describe('UsageController history reads', () => {
  it('boots through Loader and reads persisted history without attaching sessions or Agents', async () => {
    const { ctx, controller } = await harness(undefined, true)
    const meta = header('historical')
    await persist(ctx, meta, turn(user(), message(usage(100))))
    expect(ctx.sessions.list()).toHaveLength(0)
    expect(await controller.get(request, signal())).toMatchObject({
      summary: { totalTokens: 100, sessionCount: 1, messageCount: 1 },
      coverage: { unreadableSessions: 0, missingUsageAttempts: 0 },
    })
    expect(ctx.sessions.list()).toHaveLength(0)
    expect(ctx.get('agents')).toBeUndefined()
    expect(controller.typertRemote.namespace).toBe('usage')
  })

  it('uses the live cut exactly once when the same session is also persisted', async () => {
    const { ctx, controller } = await harness()
    const meta = header('both')
    const events = turn(user(), message(usage()))
    await persist(ctx, meta, events)
    const live = ctx.sessions.create(meta.id, { seed: events, meta })
    live.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(await controller.get(request, signal())).toMatchObject({ summary: { totalTokens: 100, sessionCount: 1, messageCount: 2 } })
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession')
    expect((await controller.get(request, signal())).summary.messageCount).toBe(2)
    expect(observed).not.toHaveBeenCalled()
    live.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect((await controller.get(request, signal())).summary.messageCount).toBe(3)
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenLastCalledWith(meta.id, expect.objectContaining({ projectionMode: 'none' }))
  })

  it('reuses compact summaries beyond the prepared-log cache and refreshes another backend writer append', async () => {
    const { ctx, controller, persistenceRoot } = await harness()
    const metas = Array.from({ length: 7 }, (_, index) => header(`cold-${index}`))
    for (const meta of metas) await persist(ctx, meta, turn(user(), message(usage())))
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(700)
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const opened = vi.spyOn(ctx.sessionPersistence, 'open')
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(700)
    expect(observed).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    await using writer = await other.sessionPersistence.open(metas[0]!.id, 'write')
    await writer.append([{ ...user(), seq: SessionSeq(turn(user(), message(usage())).length) }])
    await writer.flush()
    expect((await controller.get(request, signal())).summary.messageCount).toBe(8)
    expect(observed).toHaveBeenCalledOnce()
  })

  it('invalidates cached dates on time-zone changes and bounds retained session summaries', async () => {
    const { ctx, controller } = await harness({ concurrentReads: 1, cacheSize: 1 })
    for (const id of ['one', 'two']) {
      ctx.sessions.create(header(id).id, { seed: [user(Date.parse('2026-09-07T20:00:00Z'))], meta: header(id) })
    }
    expect((await controller.get(request, signal())).daily.at(-1)?.messages).toBe(0)
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession')
    expect((await controller.get({ ...request, timeZone: 'Asia/Shanghai' }, signal())).daily.at(-1)?.messages).toBe(2)
    expect(observed).toHaveBeenCalledTimes(2)
    observed.mockClear()
    await controller.get({ ...request, timeZone: 'Asia/Shanghai' }, signal())
    expect(observed).toHaveBeenCalledTimes(2)
  })

  it('reads live sessions without persistence and drops summaries after their owner unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(UsageController, { concurrentReads: 4, cacheSize: 256 })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const session = ctx.sessions.prepare(header().id, { seed: [user()], meta: header() })
    const detach = ctx.sessions.enter(session)
    ctx.effect(() => detach)
    expect((await ctx.usageController.get(request, signal())).summary.messageCount).toBe(1)
    detach()
    expect((await ctx.usageController.get(request, signal())).summary.messageCount).toBe(0)
    const replacement = ctx.sessions.prepare(header().id, { seed: [user(), { ...user(), seq: SessionSeq(1) }], meta: header() })
    const detachReplacement = ctx.sessions.enter(replacement)
    ctx.effect(() => detachReplacement)
    expect((await ctx.usageController.get(request, signal())).summary.messageCount).toBe(2)
  })

  it('refreshes a cached live session after it detaches into persisted history', async () => {
    const { ctx, controller } = await harness()
    const meta = header('detach')
    const events = turn(user(), message(usage()))
    await persist(ctx, meta, events)
    const session = ctx.sessions.prepare(meta.id, { seed: events, meta })
    const detach = ctx.sessions.enter(session)
    ctx.effect(() => detach)
    await controller.get(request, signal())
    detach()
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession')
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(100)
    expect(observed).toHaveBeenCalledOnce()
  })

  it('does not cache an old backend observation under a replacement backend identity', async () => {
    const { ctx, controller, directory, persistenceFiber } = await harness()
    const meta = header('swap')
    await persist(ctx, meta, turn(user(), message(usage(100))))
    const replacementRoot = join(directory, 'replacement')
    const external = new Context()
    contexts.push(external)
    await external.plugin(JsonlSessionPersistence, { root: replacementRoot, compression: 'none' })
    await persist(external, meta, turn(user(), message(usage(200))))
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (id, options) => {
      const cut = await original(id, options)
      await persistenceFiber!.dispose()
      await ctx.plugin(JsonlSessionPersistence, { root: replacementRoot, compression: 'none' })
      return cut
    })
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(100)
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(200)
    expect(observed).toHaveBeenCalledTimes(2)
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(200)
    expect(observed).toHaveBeenCalledTimes(2)
  })

  it('reports one unreadable history separately and retries it on the next request', async () => {
    const { ctx, controller } = await harness()
    for (const id of ['good', 'bad']) await persist(ctx, header(id), turn(user(), message(usage())))
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observed = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(() => Promise.reject(new Error('read failed')))
    expect(await controller.get(request, signal())).toMatchObject({ summary: { totalTokens: 100 }, coverage: { unreadableSessions: 1 } })
    observed.mockImplementation(original)
    expect(await controller.get(request, signal())).toMatchObject({ summary: { totalTokens: 200 }, coverage: { unreadableSessions: 0 } })
  })

  it('rejects an overall corpus failure and invalid wire requests explicitly', async () => {
    const { ctx, controller } = await harness()
    await expect(controller.get({ days: 14, timeZone: 'UTC' } as never, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.get({ days: 7, timeZone: 'Mars/Olympus' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(controller.get({ days: 7, timeZone: '+08:00' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockRejectedValue(new Error('unavailable corpus'))
    await expect(controller.get(request, signal())).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('fails when every listed history is unreadable and still accepts an empty corpus', async () => {
    const { ctx, controller } = await harness()
    expect((await controller.get(request, signal())).summary.totalTokens).toBe(0)
    for (const id of ['bad-one', 'bad-two']) await persist(ctx, header(id), turn(user(), message(usage())))
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('backend cannot open logs'))
    await expect(controller.get(request, signal())).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('excludes inherited history from persisted forks using the stored seed cut', async () => {
    const { ctx, controller } = await harness()
    const seed = turn(user(), message(usage(100)))
    await persist(ctx, header('parent'), seed)
    await persist(ctx, header('fork', { isSeeded: true, parentSession: header('parent').id }), [
      ...seed, event('session/end-seed', {}), user(),
    ], seed.length)
    expect((await controller.get(request, signal())).summary).toMatchObject({ totalTokens: 100, sessionCount: 2, messageCount: 2 })
  })
})

describe('UsageController operation lifetime', () => {
  it('validates explicit configuration before reading history', () => {
    for (const config of [{ concurrentReads: 0, cacheSize: 256 }, { concurrentReads: 4, cacheSize: 1.5 }]) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new UsageController(ctx, config)).toThrow(/positive safe integer/)
    }
  })

  it('rejects an already cancelled read before listing sessions', async () => {
    const { ctx, controller } = await harness()
    const listed = vi.spyOn(ctx.sessionQuery, 'listSessions')
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(controller.get(request, cancellation.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(listed).not.toHaveBeenCalled()
  })

  it('limits simultaneous reads and waits for leases to settle when the plugin unloads', async () => {
    const { ctx, controller, fiber } = await harness({ concurrentReads: 2, cacheSize: 256 })
    for (const id of ['one', 'two', 'three']) ctx.sessions.create(header(id).id, { seed: [user()], meta: header(id) })
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let concurrent = 0
    let maximum = 0
    let closed = 0
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      concurrent += 1
      maximum = Math.max(maximum, concurrent)
      if (concurrent === 2) started.resolve(undefined)
      const value = await original(id, options)
      await release.promise
      concurrent -= 1
      return { ...value, [Symbol.dispose]: () => { closed += 1; value[Symbol.dispose]() } }
    })
    const read = controller.get(request, signal())
    const rejected = expect(read).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await started.promise
    let disposed = false
    const disposal = fiber!.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await rejected
    await disposal
    expect(maximum).toBe(2)
    expect(closed).toBe(2)
    expect(concurrent).toBe(0)
    expect(ctx.get('usageController')).toBeUndefined()
  })
})
