import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientUsageModel } from '../src/client/model.ts'
import { FakeUsageRemote, REQUEST, usage } from './fixture.client.ts'

const benches = new Set<{ model: ClientUsageModel; remote: FakeUsageRemote }>()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const bench of benches) {
    bench.remote.settleAll()
    await bench.model.dispose()
  }
  benches.clear()
})

function mount(): { model: ClientUsageModel; remote: FakeUsageRemote } {
  const remote = new FakeUsageRemote()
  const bench = { remote, model: new ClientUsageModel(remote) }
  benches.add(bench)
  return bench
}

describe('Client usage query state', () => {
  it('keeps an identity-stable idle snapshot without eagerly reading or refreshing', async () => {
    const { model, remote } = mount()
    const initial = model.getSnapshot()
    const listener = vi.fn()
    const stop = model.subscribe(listener)
    await model.refresh()
    expect(remote.calls).toEqual([])
    expect(initial).toEqual({ status: 'idle', request: null, data: null, error: null })
    expect(model.getSnapshot()).toBe(initial)
    stop()
    const loaded = model.load(REQUEST)
    remote.settleAll()
    await loaded
    expect(listener).not.toHaveBeenCalled()
    expect(model.getSnapshot()).toBe(model.getSnapshot())
  })

  it('retains the last complete result through a failed refresh and clears the error on retry', async () => {
    const { model, remote } = mount()
    const first = model.load(REQUEST)
    const data = usage()
    expect(model.getSnapshot()).toEqual({ status: 'loading', request: REQUEST, data: null, error: null })
    remote.calls[0]!.result.resolve({ ok: true, value: data })
    await first
    const retry = model.load(REQUEST)
    expect(model.getSnapshot()).toMatchObject({ status: 'loading', data, error: null })
    remote.calls[1]!.result.resolve({
      ok: false,
      error: new RemoteError('gateway/internal', 'history unavailable', {}),
    })
    await retry
    expect(model.getSnapshot()).toEqual({ status: 'error', request: REQUEST, data, error: 'history unavailable' })
    const recovered = model.load(REQUEST)
    expect(model.getSnapshot()).toMatchObject({ status: 'loading', data, error: null })
    remote.calls[2]!.result.resolve({ ok: true, value: usage(REQUEST, 240) })
    await recovered
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', data: { summary: { totalTokens: 240 } }, error: null })
  })

  it('aborts the old range and ignores its late success after the latest range succeeds', async () => {
    const { model, remote } = mount()
    const old = model.load(REQUEST)
    const request = { ...REQUEST, days: 7 as const }
    const latest = model.load(request)
    expect(remote.calls[0]!.signal?.aborted).toBe(true)
    expect(remote.calls[1]!.signal?.aborted).toBe(false)
    remote.calls[1]!.result.resolve({ ok: true, value: usage(request, 700) })
    await latest
    const installed = model.getSnapshot()
    remote.calls[0]!.result.resolve({ ok: true, value: usage(REQUEST, 3000) })
    await old
    expect(model.getSnapshot()).toBe(installed)
    expect(installed).toMatchObject({ status: 'ready', request, data: { summary: { totalTokens: 700 } } })
  })

  it('ignores a superseded rejection without clearing the current pending request', async () => {
    const { model, remote } = mount()
    const old = model.load(REQUEST)
    const current = model.load({ ...REQUEST, days: 7 })
    remote.calls[0]!.result.reject(new Error('old carrier failed'))
    await old
    expect(model.getSnapshot()).toMatchObject({ status: 'loading', request: { days: 7 }, error: null })
    const replacement = model.load(REQUEST)
    expect(remote.calls[1]!.signal?.aborted).toBe(true)
    remote.settleAll()
    await Promise.all([current, replacement])
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', request: REQUEST })
  })

  it.each([new Error('unmounted usage method'), 'missing Remote assembly'])('publishes a rejected Remote call as a retryable error: %s', async (error) => {
    const { model, remote } = mount()
    const loaded = model.load(REQUEST)
    remote.calls[0]!.result.reject(error)
    await loaded
    expect(model.getSnapshot()).toMatchObject({
      status: 'error',
      data: null,
      error: error instanceof Error ? error.message : error,
    })
  })

  it('resamples the local time zone for every refresh while keeping the selected range', async () => {
    const { model, remote } = mount()
    const initial = model.load({ ...REQUEST, days: 7 })
    remote.settleAll()
    await initial
    const options = new Intl.DateTimeFormat().resolvedOptions()
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ ...options, timeZone: 'Pacific/Auckland' })
    const first = model.refresh()
    expect(remote.calls[1]!.request).toEqual({ days: 7, timeZone: 'Pacific/Auckland' })
    remote.settleAll()
    await first
    zone.mockReturnValue({ ...options, timeZone: 'America/Los_Angeles' })
    const second = model.refresh()
    expect(remote.calls[2]!.request).toEqual({ days: 7, timeZone: 'America/Los_Angeles' })
    remote.settleAll()
    await second
  })

  it('contains subscriber failures and notifies the other observers', async () => {
    const { model, remote } = mount()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    model.subscribe(() => { throw new Error('broken subscriber') })
    const listener = vi.fn()
    model.subscribe(listener)
    const loaded = model.load(REQUEST)
    remote.settleAll()
    await loaded
    expect(listener).toHaveBeenCalledTimes(2)
    expect(logged).toHaveBeenCalledTimes(2)
    expect(model.getSnapshot().status).toBe('ready')
  })

  it('awaits superseded and current reads on disposal and suppresses late changes', async () => {
    const { model, remote } = mount()
    const old = model.load(REQUEST)
    const current = model.load({ ...REQUEST, days: 7 })
    const listener = vi.fn()
    model.subscribe(listener)
    const beforeDisposal = model.getSnapshot()
    let disposed = false
    const disposal = model.dispose().then(() => { disposed = true })
    expect(remote.calls.every(call => call.signal?.aborted)).toBe(true)
    remote.calls[1]!.result.resolve({ ok: true, value: usage() })
    await current
    expect(disposed).toBe(false)
    remote.calls[0]!.result.reject(new Error('cancelled carrier settled'))
    await Promise.all([old, disposal])
    expect(disposed).toBe(true)
    expect(model.getSnapshot()).toBe(beforeDisposal)
    const stop = model.subscribe(listener)
    await model.load(REQUEST)
    await model.refresh()
    await model.dispose()
    stop()
    expect(remote.calls).toHaveLength(2)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not launch a query when a loading observer disposes its owner', async () => {
    const { model, remote } = mount()
    const disposal = Promise.withResolvers<undefined>()
    model.subscribe(() => { void model.dispose().then(() => { disposal.resolve(undefined) }) })
    await model.load(REQUEST)
    await disposal.promise
    expect(remote.calls).toEqual([])
  })
})
