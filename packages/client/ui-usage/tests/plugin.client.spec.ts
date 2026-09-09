import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UsageClientSnapshot } from '@deepseek-ai/dsh-api-usage-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { UsageSection } from '../src/client/UsageSection.tsx'
import type { UsageSectionInjected } from '../src/client/UsageSection.tsx'
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
  const usage = {
    snapshot: createSnapshotStore<UsageClientSnapshot>({ status: 'idle', request: null, data: null, error: null }),
    load: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined),
  }
  ctx.provide('usage', usage)
  return { ctx, locale, usage, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry) {
  return slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
}

describe('usage plugin', () => {
  it('has an inert host entry and binds lazy queries to the Client snapshot', async () => {
    expect(hostApply).not.toThrow()
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject, apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(UsageSection)
    expect(entry.options).toMatchObject({ id: 'usage', order: 40 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Usage statistics')
    expect(b.usage.load).not.toHaveBeenCalled()
    const face = (entry.inject as unknown as () => UsageSectionInjected)()
    expect(face.hooks.usage).toBe(b.usage.snapshot)
    await face.load(7)
    expect(b.usage.load).toHaveBeenCalledExactlyOnceWith({ days: 7, timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone })
    await face.refresh()
    expect(b.usage.refresh).toHaveBeenCalledOnce()
  })

  it('follows settings declaration lifetimes and removes the page and locales on unload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('使用统计')
    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(() => b.locale.register('settings.usage', { en, zh })).not.toThrow()
  })
})
