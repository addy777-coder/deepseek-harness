/** Remote lifecycle events and connection recovery belong to the Client plugin lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as VpnClient from '../src/client/index.ts'
import type { VpnSettingsView } from '../src/types.ts'
import { FakeVpnRemote, request, view } from './fixture.client.ts'

const benches: Array<{ ctx: Context; remote: FakeVpnRemote }> = []
afterEach(async () => {
  for (const b of benches.splice(0)) { b.remote.settleAll(); await b.ctx.fiber.dispose() }
})

async function bench() {
  const ctx = new Context()
  const remote = new FakeVpnRemote()
  benches.push({ ctx, remote })
  const listeners = new Set<(view: VpnSettingsView) => void>()
  ctx.reflect.provide('remote', { vpn: remote, $on: (event: string, listener: (view: VpnSettingsView) => void) => {
    expect(event).toBe('network/changed')
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } })
  ctx.reflect.provide('remote.vpn', remote)
  const fiber = ctx.plugin(VpnClient)
  await fiber.await()
  return { ctx, remote, fiber, listeners, service: ctx.vpn }
}

describe('VPN Client plugin', () => {
  it('subscribes without polling, forwards actions, and refreshes after connection recovery', async () => {
    const b = await bench()
    expect(b.remote.calls).toHaveLength(0)
    expect(b.listeners.size).toBe(1)
    b.ctx.emit('connection/reset')
    expect(b.remote.calls).toHaveLength(0)
    for (const listener of b.listeners) listener(view('connected'))
    expect(b.service.snapshot.getSnapshot().data?.connection).toBe('connected')
    const load = b.service.load()
    b.remote.settleAll()
    await load
    const save = b.service.saveAndConnect(request)
    b.remote.settleAll()
    await expect(save).resolves.toBe(true)
    const connect = b.service.connect()
    b.remote.settleAll()
    await connect
    const disconnect = b.service.disconnect()
    b.remote.settleAll()
    await disconnect
    expect(b.remote.calls.map(call => call.method)).toEqual(['get', 'save', 'connect', 'disconnect'])
    const refreshed = Promise.withResolvers<undefined>()
    const stop = b.service.snapshot.subscribe(() => {
      if (b.service.snapshot.getSnapshot().status === 'ready') refreshed.resolve(undefined)
    })
    b.ctx.emit('connection/reset')
    expect(b.remote.calls[4]!.method).toBe('get')
    b.remote.settleAll()
    await refreshed.promise
    stop()
  })

  it('withdraws event handlers and waits for cancelled calls before disposal settles', async () => {
    const b = await bench()
    const load = b.service.load()
    const aborted = Promise.withResolvers<undefined>()
    b.remote.calls[0]!.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    const listener = vi.fn()
    b.service.snapshot.subscribe(listener)
    let disposed = false
    const disposal = b.fiber.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    b.remote.settleAll()
    await Promise.all([load, disposal])
    expect(b.listeners.size).toBe(0)
    expect(b.ctx.get('vpn')).toBeUndefined()
    b.ctx.emit('connection/reset')
    await b.service.load()
    expect(b.remote.calls).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
  })
})
