import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as UsageClient from '../src/client/index.ts'
import type { IUsage, UsageClientSnapshot } from '../src/client/index.ts'
import { FakeUsageRemote, REQUEST, usage } from './fixture.client.ts'

interface Bench {
  ctx: Context
  fiber: Fiber
  remote: FakeUsageRemote
  service: IUsage
}

const benches = new Set<Bench>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const bench of benches) {
    bench.remote.settleAll()
    await bench.ctx.fiber.dispose()
  }
  benches.clear()
})

async function mount(): Promise<Bench> {
  const ctx = new Context()
  const remote = new FakeUsageRemote()
  ctx.reflect.provide('remote', { usage: remote })
  ctx.reflect.provide('remote.usage', remote)
  const fiber = ctx.plugin(UsageClient)
  const bench = { ctx, fiber, remote, get service() { return ctx.usage } }
  benches.add(bench)
  await fiber
  return bench
}

function nextReady(service: IUsage): Promise<UsageClientSnapshot> {
  const result = Promise.withResolvers<UsageClientSnapshot>()
  const stop = service.snapshot.subscribe(() => {
    const snapshot = service.snapshot.getSnapshot()
    if (snapshot.status !== 'ready') return
    stop()
    result.resolve(snapshot)
  })
  return result.promise
}

describe('Usage Controller Client plugin', () => {
  it('stays lazy until opened, then refreshes after reconnecting with the current time zone', async () => {
    const bench = await mount()
    bench.ctx.emit('connection/reset')
    await bench.service.refresh()
    expect(bench.remote.calls).toEqual([])
    expect(bench.service.snapshot.getSnapshot().status).toBe('idle')
    const loaded = bench.service.load(REQUEST)
    bench.remote.settleAll()
    await loaded
    const options = new Intl.DateTimeFormat().resolvedOptions()
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ ...options, timeZone: 'Europe/Paris' })
    const ready = nextReady(bench.service)
    bench.ctx.emit('connection/reset')
    expect(bench.remote.calls[1]!.request).toEqual({ days: 30, timeZone: 'Europe/Paris' })
    bench.remote.calls[1]!.result.resolve({ ok: true, value: usage(bench.remote.calls[1]!.request, 300) })
    await expect(ready).resolves.toMatchObject({
      status: 'ready', request: { timeZone: 'Europe/Paris' }, data: { summary: { totalTokens: 300 } },
    })
  })

  it('withdraws the service and reconnect listener after awaiting an active query', async () => {
    const bench = await mount()
    const service = bench.service
    const loaded = service.load(REQUEST)
    const listener = vi.fn()
    service.snapshot.subscribe(listener)
    const aborted = Promise.withResolvers<undefined>()
    bench.remote.calls[0]!.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    let settled = false
    const disposal = bench.fiber.dispose().then(() => { settled = true })
    await aborted.promise
    expect(bench.remote.calls[0]!.signal?.aborted).toBe(true)
    expect(settled).toBe(false)
    bench.remote.settleAll()
    await Promise.all([loaded, disposal])
    expect(bench.ctx.get('usage')).toBeUndefined()
    bench.ctx.emit('connection/reset')
    await service.load(REQUEST)
    await service.refresh()
    expect(bench.remote.calls).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
  })
})
