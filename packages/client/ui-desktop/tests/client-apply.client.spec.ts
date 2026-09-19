import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

it.each(['pending', 'ready'] as const)('subscribes to navigation after the Session baseline (%s at activation)', async (phase) => {
  const ctx = new Context()
  const list = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase,
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const open = vi.fn()
  const clear = vi.fn()
  const stopIntent = vi.fn()
  const onIntent = vi.fn((_listener: (intent: { type: 'new-task' } | { type: 'open-session'; sessionId: SessionId }) => void) => stopIntent)
  vi.stubGlobal('__DSH_DESKTOP__', { version: '0.1.0' })
  vi.stubGlobal('dshDesktop', {
    reportSelection: vi.fn(),
    notifyTaskSettled: vi.fn(),
    onIntent,
    onUpdateState: () => () => {},
    getUpdateState: async () => ({ phase: 'idle' }),
  })
  const slotsFiber = ctx.plugin(SlotRegistry)
  let fiber: ReturnType<Context['plugin']> | undefined
  try {
    await slotsFiber.await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { list, open, clear } as never)
    fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    expect(onIntent).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0)
    list.set({ ...list.getSnapshot(), phase: 'ready' })
    expect(onIntent).toHaveBeenCalledOnce()
    onIntent.mock.calls[0]?.[0]({ type: 'open-session', sessionId: 'linked-session' as SessionId })
    onIntent.mock.calls[0]?.[0]({ type: 'new-task' })
    expect(open).toHaveBeenCalledWith('linked-session')
    expect(clear).toHaveBeenCalledOnce()
    list.set({ ...list.getSnapshot() })
    expect(onIntent).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(stopIntent).toHaveBeenCalledOnce()
    list.set({ ...list.getSnapshot() })
    expect(onIntent).toHaveBeenCalledOnce()
  } finally {
    await fiber?.dispose()
    await slotsFiber.dispose()
  }
})
