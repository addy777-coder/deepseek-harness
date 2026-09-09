/** Query, action, event, and teardown orderings preserve the newest redacted state. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientVpnModel } from '../src/client/model.ts'
import { FakeVpnRemote, request, view } from './fixture.client.ts'

const benches: Array<{ model: ClientVpnModel; remote: FakeVpnRemote }> = []
afterEach(async () => {
  for (const b of benches.splice(0)) { b.remote.settleAll(); await b.model.dispose() }
  vi.restoreAllMocks()
})

function bench() {
  const remote = new FakeVpnRemote()
  const b = { remote, model: new ClientVpnModel(remote) }
  benches.push(b)
  return b
}

describe('Client VPN state', () => {
  it('starts idle without reading and retains the last result through a sanitized failure', async () => {
    const { model, remote } = bench()
    const idle = model.getSnapshot()
    expect(idle).toEqual({ status: 'idle', data: null, busy: false, error: null })
    expect(model.getSnapshot()).toBe(idle)
    expect(remote.calls).toHaveLength(0)
    const load = model.load()
    remote.settleAll()
    await load
    const retry = model.load()
    remote.calls[1]!.result.resolve({ ok: false, error: new RemoteError('vpn/rejected', 'private native output', { code: 'VPN_RUNTIME_MISSING' }) })
    await retry
    expect(model.getSnapshot()).toMatchObject({ status: 'error', data: view(), error: 'VPN_RUNTIME_MISSING' })
    const recover = model.load()
    expect(model.getSnapshot().error).toBeNull()
    remote.settleAll()
    await recover
  })

  it.each(['success', 'failure', 'rejection'] as const)('ignores a read %s that arrives after a Host event', async (outcome) => {
    const { model, remote } = bench()
    const load = model.load()
    model.accept(view('connected'))
    const newest = model.getSnapshot()
    if (outcome === 'success') remote.calls[0]!.result.resolve({ ok: true, value: view('disconnected') })
    else if (outcome === 'failure') remote.calls[0]!.result.resolve({ ok: false, error: new RemoteError('gateway/internal', 'private', {}) })
    else remote.calls[0]!.result.reject(new Error('private'))
    await load
    expect(model.getSnapshot()).toBe(newest)
  })

  it('aborts superseded reads and prevents a read from overwriting a newer command', async () => {
    const { model, remote } = bench()
    const old = model.load()
    const replacement = model.load()
    expect(remote.calls[0]!.signal?.aborted).toBe(true)
    const command = model.disconnect()
    expect(remote.calls[1]!.signal?.aborted).toBe(true)
    remote.calls[2]!.result.resolve({ ok: true, value: view('disconnected') })
    await command
    remote.calls[0]!.result.reject(new Error('old read'))
    remote.calls[1]!.result.resolve({ ok: true, value: view('connected') })
    await Promise.all([old, replacement])
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', data: view('disconnected') })
  })

  it.each(['success', 'failure', 'rejection'] as const)('preserves a later disconnect after an older connect %s', async (outcome) => {
    const { model, remote } = bench()
    const connect = model.connect()
    const disconnect = model.disconnect()
    remote.calls[1]!.result.resolve({ ok: true, value: view('disconnected') })
    await disconnect
    expect(model.getSnapshot().busy).toBe(true)
    if (outcome === 'success') remote.calls[0]!.result.resolve({ ok: true, value: view('connected') })
    else if (outcome === 'failure') remote.calls[0]!.result.resolve({ ok: false, error: new RemoteError('vpn/rejected', 'private', { code: 'AUTH_FAILED' }) })
    else remote.calls[0]!.result.reject(new Error('private'))
    await connect
    expect(model.getSnapshot()).toMatchObject({ status: 'ready', data: view('disconnected'), busy: false, error: null })
  })

  it('keeps a newer event when a command result arrives and reports committed saves independently', async () => {
    const { model, remote } = bench()
    const saved = model.saveAndConnect(request)
    expect(remote.calls[0]).toMatchObject({ method: 'save', request })
    model.accept(view('connected'))
    remote.calls[0]!.result.resolve({ ok: true, value: view('connecting') })
    await expect(saved).resolves.toBe(true)
    expect(model.getSnapshot()).toMatchObject({ data: view('connected'), busy: false })
    expect(JSON.stringify(model.getSnapshot())).not.toContain('local-only-secret')
  })

  it.each(['VPN_PROVIDER_CONFIGURATION_FAILED', 'VPN_SAVED_CONNECTION_FAILED'])('reports %s after persistence without retaining the secret draft', async (code) => {
    const { model, remote } = bench()
    const saved = model.saveAndConnect(request)
    model.accept(view())
    remote.calls[0]!.result.resolve({ ok: true, value: { ...view(), failure: { code } } })
    await expect(saved).resolves.toBe(true)
    expect(model.getSnapshot()).toMatchObject({ data: view(), error: code, busy: false })
  })

  it('sanitizes rejected calls and unsuccessful responses, then clears errors on a Host event', async () => {
    const { model, remote } = bench()
    const save = model.saveAndConnect(request)
    remote.calls[0]!.result.resolve({ ok: false, error: new RemoteError('gateway/internal', 'private address and password', {}) })
    await expect(save).resolves.toBe(false)
    expect(model.getSnapshot().error).toBe('VPN_RPC_FAILED')
    const connect = model.connect()
    remote.calls[1]!.result.reject(new Error('private native output'))
    await connect
    expect(model.getSnapshot().error).toBe('VPN_RPC_FAILED')
    model.accept(view())
    expect(model.getSnapshot().error).toBeNull()
    const load = model.load()
    remote.calls[2]!.result.reject(new Error('private RPC detail'))
    await load
    expect(model.getSnapshot()).toMatchObject({ status: 'error', error: 'VPN_RPC_FAILED' })
  })

  it('keeps a latest command refusal visible after the command emits a lifecycle event', async () => {
    const { model, remote } = bench()
    const save = model.saveAndConnect(request)
    model.accept(view('disconnected'))
    remote.calls[0]!.result.resolve({ ok: false, error: new RemoteError('vpn/rejected', 'private credential detail', {
      code: 'VPN_CREDENTIALS_MISSING',
    }) })
    await expect(save).resolves.toBe(false)
    expect(model.getSnapshot()).toMatchObject({ data: view('disconnected'), error: 'VPN_CREDENTIALS_MISSING' })
  })

  it('contains subscriber failures and removes subscriptions', async () => {
    const { model } = bench()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    model.subscribe(() => { throw new Error('broken subscriber') })
    const listener = vi.fn()
    const stop = model.subscribe(listener)
    model.accept(view())
    stop()
    model.accept(view('connected'))
    expect(listener).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledTimes(2)
  })

  it('awaits every active call on disposal, aborts them, and suppresses all later publications', async () => {
    const { model, remote } = bench()
    const read = model.load()
    const save = model.saveAndConnect(request)
    const installed = model.getSnapshot()
    let disposed = false
    const disposal = model.dispose().then(() => { disposed = true })
    expect(remote.calls.every(call => call.signal?.aborted)).toBe(true)
    remote.calls[1]!.result.resolve({ ok: true, value: view('connected') })
    await expect(save).resolves.toBe(false)
    expect(disposed).toBe(false)
    remote.calls[0]!.result.reject(new Error('closed carrier'))
    await Promise.all([read, disposal])
    expect(disposed).toBe(true)
    model.accept(view())
    await model.load()
    await expect(model.saveAndConnect(request)).resolves.toBe(false)
    const listener = vi.fn()
    model.subscribe(listener)()
    expect(model.getSnapshot()).toBe(installed)
    expect(remote.calls).toHaveLength(2)
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['load', 'connect'] as const)('does not launch %s when an observer disposes during the initial publication', async (method) => {
    const { model, remote } = bench()
    const stopped = Promise.withResolvers<undefined>()
    model.subscribe(() => { void model.dispose().then(() => { stopped.resolve(undefined) }) })
    await model[method]()
    await stopped.promise
    expect(remote.calls).toHaveLength(0)
  })
})
