/** VPN settings registration follows declaration, dictionary, and plugin lifetimes. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SaveVpnRequest, VpnClientSnapshot } from '@deepseek-ai/dsh-api-vpn-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { VpnSection, type VpnSectionInjected } from '../src/client/VpnSection.tsx'
import { apply as hostApply } from '../src/index.ts'
import { en, zh } from '../src/client/locales.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const vpn = {
    snapshot: createSnapshotStore<VpnClientSnapshot>({ status: 'idle', data: null, busy: false, error: null }),
    load: vi.fn<() => Promise<void>>().mockResolvedValue(),
    saveAndConnect: vi.fn<(request: SaveVpnRequest) => Promise<boolean>>().mockResolvedValue(true),
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(),
  }
  ctx.provide('vpn', vpn)
  return { ctx, locale, vpn, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry) {
  return slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
}

describe('VPN settings plugin', () => {
  it('binds public state and forwards commands without starting a load during registration', async () => {
    expect(hostApply).not.toThrow()
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject, apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(VpnSection)
    expect(entry.options).toMatchObject({ id: 'vpn', order: 35 })
    expect(entry.locale).toBe('settings.vpn')
    expect(resolveSlotLabel(entry.options.label)).toBe(en.title)
    expect(b.vpn.load).not.toHaveBeenCalled()
    const face = (entry.inject as unknown as () => VpnSectionInjected)()
    expect(face.hooks.vpn).toBe(b.vpn.snapshot)
    await face.load()
    const request: SaveVpnRequest = { username: 'employee', password: 'temporary-secret', autoConnect: true }
    await expect(face.saveAndConnect(request)).resolves.toBe(true)
    await face.connect()
    await face.disconnect()
    expect(b.vpn.load).toHaveBeenCalledOnce()
    expect(b.vpn.saveAndConnect).toHaveBeenCalledExactlyOnceWith(request)
    expect(b.vpn.connect).toHaveBeenCalledOnce()
    expect(b.vpn.disconnect).toHaveBeenCalledOnce()
  })

  it('removes the page and dictionary on declaration withdrawal and plugin disposal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe(zh.title)
    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.vpn', { en, zh })).not.toThrow()
  })
})
