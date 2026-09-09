// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UsageClientSnapshot } from '@deepseek-ai/dsh-api-usage-controller/client'
import type { UsageSnapshot } from '@deepseek-ai/dsh-api-usage-controller/types'
import { UsageSection } from '../src/client/UsageSection.tsx'
import type { UsageSectionProps } from '../src/client/UsageSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(): UsageSnapshot {
  const models = Array.from({ length: 7 }, (_, index) => ({ provider: 'DeepSeek', model: `model-${String(index)}`, tokens: (7 - index) * 100 }))
  return {
    days: 30, timeZone: 'Asia/Shanghai', from: '2026-08-10', to: '2026-09-08', generatedAt: Date.UTC(2026, 8, 8, 4),
    summary: { totalTokens: 2800, sessionCount: 2, messageCount: 8, activeDays: 1, currentStreak: 1, mostUsedModel: models[0]! },
    daily: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 7, 10 + index)).toISOString().slice(0, 10),
      tokens: index === 29 ? 2800 : 0, messages: index === 29 ? 8 : 0,
      sessions: index === 29 ? 2 : 0, models: index === 29 ? models : [],
    })),
    models,
    heatmap: Array.from({ length: 365 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 8, 9 + index)).toISOString().slice(0, 10), messages: index === 364 ? 8 : 0,
    })),
    coverage: { unreadableSessions: 0, missingUsageAttempts: 0 },
  }
}

function setup(state: Partial<UsageClientSnapshot> = {}, dictionary = en) {
  const source = createSnapshotStore<UsageClientSnapshot>({ status: 'idle', request: null, data: null, error: null, ...state })
  const load = vi.fn<(days: 7 | 30) => Promise<void>>().mockResolvedValue()
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue()
  const t = (key: keyof typeof en, params: Record<string, string> = {}) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name)
  const props = { t, useUsage: bindSnapshotSelector(source), load, refresh } as unknown as UsageSectionProps
  render(<UsageSection {...props} />)
  return { source, load, refresh }
}

describe('UsageSection', () => {
  it('loads thirty days on opening and queries the range chosen by the user', () => {
    const b = setup()
    expect(b.load).toHaveBeenCalledExactlyOnceWith(30)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(screen.getByRole('button', { name: en.thirtyDays }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.sevenDays }))
    expect(b.load).toHaveBeenLastCalledWith(7)
    act(() => {
      b.source.set({ ...b.source.getSnapshot(), status: 'ready', request: { days: 7, timeZone: 'UTC' }, data: fixture() })
    })
    expect(screen.getByRole('button', { name: en.sevenDays }).getAttribute('aria-pressed')).toBe('true')
    expect(b.load).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: en.thirtyDays }))
    expect(b.load).toHaveBeenLastCalledWith(30)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('keeps the selected range when reopening and exposes six metrics with all model totals', () => {
    const b = setup({ status: 'ready', request: { days: 7, timeZone: 'UTC' }, data: fixture() })
    expect(b.load).toHaveBeenCalledExactlyOnceWith(7)
    const metrics = document.querySelector('[data-usage-summary]')!
    expect(within(metrics as HTMLElement).getAllByRole('term')).toHaveLength(6)
    expect(within(metrics as HTMLElement).getByText('2.8K')).toBeTruthy()
    const models = document.querySelector('[data-usage-models]')!
    expect(within(models as HTMLElement).getAllByRole('listitem')).toHaveLength(7)
    expect(within(models as HTMLElement).getByText('model-6 · DeepSeek')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Other: 300 tokens, 10.7% of tokens' })).toBeTruthy()
    expect(screen.getByText(en.scope)).toBeTruthy()
    expect(screen.getByText('Time zone: Asia/Shanghai')).toBeTruthy()
    fireEvent.click(screen.getByText(en.dailyData))
    expect(screen.getAllByRole('row')).toHaveLength(31)
  })

  it('shows hover and keyboard chart details and navigates the annual heatmap by date', () => {
    setup({ status: 'ready', data: fixture() })
    const heatmap = screen.getByRole('group', { name: en.heatmap })
    const days = within(heatmap).getAllByRole('img')
    const last = days[364]!
    fireEvent.mouseEnter(last)
    expect(screen.getAllByText('2026-09-08: 8 user messages')).toHaveLength(2)
    fireEvent.mouseLeave(last)
    act(() => { last.focus() })
    fireEvent.keyDown(last, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(days[363])
    fireEvent.keyDown(days[363]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(days[356])
    fireEvent.keyDown(days[356]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(days[363])
    fireEvent.keyDown(days[363]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Home' })
    expect(document.activeElement).toBe(days[0])
    fireEvent.keyDown(days[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(days[0])
    fireEvent.keyDown(days[0]!, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Enter' })
    expect(document.activeElement).toBe(last)
    const bar = screen.getByRole('img', { name: '2026-09-08, model-0 · DeepSeek: 700 tokens' })
    fireEvent.mouseEnter(bar)
    expect(screen.getAllByText('2026-09-08, model-0 · DeepSeek: 700 tokens')).toHaveLength(2)
    fireEvent.mouseLeave(bar)
    act(() => { bar.focus() })
    expect(screen.getAllByText('2026-09-08, model-0 · DeepSeek: 700 tokens')).toHaveLength(2)
    act(() => { bar.blur() })
    const arc = screen.getByRole('img', { name: 'model-0 · DeepSeek: 700 tokens, 25% of tokens' })
    fireEvent.mouseEnter(arc)
    expect(screen.getAllByText('model-0 · DeepSeek: 700 tokens, 25% of tokens')).toHaveLength(2)
    fireEvent.mouseLeave(arc)
    act(() => { arc.focus() })
    expect(screen.getAllByText('model-0 · DeepSeek: 700 tokens, 25% of tokens')).toHaveLength(2)
    act(() => { arc.blur() })
  })

  it('distinguishes partial accounting from empty activity and keeps the last available results after failure', () => {
    const data = fixture()
    data.coverage = { unreadableSessions: 2, missingUsageAttempts: 3 }
    const b = setup({ status: 'ready', data })
    expect(screen.getByText('2 sessions could not be read. These statistics are incomplete.')).toBeTruthy()
    expect(screen.getByText('3 model requests have incomplete recorded usage and are excluded from token totals.')).toBeTruthy()
    act(() => { b.source.set({ ...b.source.getSnapshot(), status: 'error', error: 'read failed' }) })
    expect(screen.getByRole('alert').textContent).toContain(en.stale)
    expect(document.querySelector('[data-usage-summary]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('shows a retry when the first read fails', () => {
    const b = setup({ status: 'error', error: 'unavailable' })
    expect(screen.getByRole('alert').textContent).toContain(en.error)
    expect(document.querySelector('[data-usage-summary]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('renders a zero-state dashboard without inventing model usage', () => {
    const data = fixture()
    data.summary = { totalTokens: 0, sessionCount: 0, messageCount: 0, activeDays: 0, currentStreak: 0, mostUsedModel: null }
    data.models = []
    data.daily = data.daily.map(day => ({ ...day, tokens: 0, messages: 0, sessions: 0, models: [] }))
    setup({ status: 'ready', data })
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.getAllByText(en.noModel)).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: en.modelUsage })).queryAllByRole('img')).toHaveLength(0)
  })

  it('formats Chinese copy and names missing model attribution', () => {
    const data = fixture()
    data.models = [{ provider: '', model: '', tokens: 0 }]
    data.summary.totalTokens = 0
    data.summary.mostUsedModel = data.models[0]!
    data.days = 7
    data.daily = data.daily.slice(-7)
    data.heatmap = []
    setup({ status: 'ready', data }, zh)
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getAllByText('未记录模型 · 未记录提供方')).toHaveLength(3)
    expect(screen.getByText('占比 0%')).toBeTruthy()
    expect(screen.getByText(zh.scope)).toBeTruthy()
  })
})
