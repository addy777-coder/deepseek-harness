/** Recorded-history usage statistics through the shipped Web settings page. */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, realizeSeedFixture, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/usage-statistics', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/turn-tail-actions/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const NOW = Date.UTC(2026, 8, 8, 12)
const RECORDED_TOKENS = 15_811

/** Preserve recorded events while placing the session on a deterministic calendar date. */
function datedFixture(text: string, createdAt: number): string {
  const newline = text.indexOf('\n')
  const header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>
  return JSON.stringify({ ...header, createdAt }) + text.slice(newline)
}

describe('web e2e: recorded usage statistics', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Only the Host calendar is fixed; real timers still drive the browser and transport.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', timezoneId: 'UTC' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() } finally { vi.useRealTimers() }
    }
  })

  async function idle(): Promise<void> {
    await expect.poll(() => page.locator('[data-usage-statistics]').getAttribute('aria-busy')).toBe('false')
  }

  function metric(label: string): Locator {
    return page.locator('[data-usage-summary] > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
  }

  async function golden(name: string): Promise<void> {
    const summary = await captureStableAria(page, '[data-usage-summary]', scaffold.workspaceCwd)
    const models = await captureStableAria(page, '[data-usage-models]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, `${name}.expected.md`), `${summary}\n${models}`, MODE)
  }

  it('realizes seed paths with Windows separators and quotes as valid JSON', () => {
    const workspaceCwd = 'C:\\work\\quoted "folder"'
    for (const cwd of ['{{cwd}}', '/recorded/workspace']) {
      const fixture = JSON.stringify({ cwd }) + '\n' + JSON.stringify({ text: `${cwd}/file.ts` })
      const realized = realizeSeedFixture({ ...scaffold, workspaceCwd }, fixture, 'usage-path')
      const lines = realized.split('\n').map(line => JSON.parse(line) as Record<string, string>)
      expect(lines).toEqual([{ cwd: workspaceCwd }, { text: `${workspaceCwd}/file.ts` }])
      expect(realizeSeedFixture({ ...scaffold, workspaceCwd }, realized, 'usage-path')).toBe(realized)
    }
  })

  it('reads cold archived sessions, filters calendar ranges, and retries a failed refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-usage-statistics'))
    await page.route('**/api/usage/get', route => route.abort('failed'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Usage statistics', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Usage statistics are temporarily unavailable.' }).waitFor()
    expect(await page.locator('[data-usage-summary]').count()).toBe(0)
    await page.unroute('**/api/usage/get')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await idle()
    expect(await metric('Sessions').textContent()).toBe('0')
    await page.getByText('No usage recorded in this period. Start a conversation to see your activity here.', { exact: true }).waitFor()

    const recorded = await readFile(await selectedSessionFixture(FIXTURE), 'utf8')
    const recent = await seedSession(scaffold, datedFixture(recorded, NOW - 3_600_000), 'usage-recent')
    await seedSession(scaffold, datedFixture(recorded, NOW - 10 * 86_400_000), 'usage-older')
    await scaffold.ctx.workspaceRegistry.archiveSession(recent)
    expect(scaffold.ctx.sessions.get(recent)).toBeUndefined()

    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await idle()
    expect(await metric('Sessions').textContent()).toBe('2')
    expect(await metric('Messages').textContent()).toBe('2')
    expect(await metric('Active days').textContent()).toBe('2')
    expect(await metric('Current streak').textContent()).toBe('1')
    expect(await metric('Tokens used').getAttribute('title')).toBe((RECORDED_TOKENS * 2).toLocaleString('en-US'))
    expect(scaffold.ctx.sessions.get(recent)).toBeUndefined()
    await golden('thirty-days')
    await mkdir('.playwright-mcp/usage-statistics', { recursive: true })
    await page.screenshot({ path: '.playwright-mcp/usage-statistics/light.png', animations: 'disabled' })

    await page.getByRole('button', { name: 'Last 7 days', exact: true }).click()
    await idle()
    expect(await metric('Sessions').textContent()).toBe('1')
    expect(await metric('Messages').textContent()).toBe('1')
    expect(await metric('Tokens used').getAttribute('title')).toBe(RECORDED_TOKENS.toLocaleString('en-US'))
    expect(await page.getByRole('button', { name: 'Last 7 days', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('group', { name: 'Activity heatmap', exact: true }).locator('rect').count()).toBe(365)
    await golden('seven-days')

    const staleReady = Promise.withResolvers<undefined>()
    const releaseStale = Promise.withResolvers<undefined>()
    const staleDone = Promise.withResolvers<undefined>()
    let holdNext = true
    let staleError: unknown
    await page.route('**/api/usage/get', async (route) => {
      if (!holdNext) { await route.continue(); return }
      holdNext = false
      try {
        const response = await route.fetch()
        staleReady.resolve(undefined)
        await releaseStale.promise
        await route.fulfill({ response })
      } catch (error) {
        staleError = error
        staleReady.resolve(undefined)
      } finally {
        staleDone.resolve(undefined)
      }
    })
    try {
      await page.getByRole('button', { name: 'Last 30 days', exact: true }).click()
      await staleReady.promise
      expect(staleError).toBeUndefined()
      await page.getByRole('button', { name: 'Last 7 days', exact: true }).click()
      await idle()
      expect(await metric('Sessions').textContent()).toBe('1')
      releaseStale.resolve(undefined)
      await staleDone.promise
      expect(staleError).toBeUndefined()
      expect(await metric('Sessions').textContent()).toBe('1')
      expect(await page.getByRole('button', { name: 'Last 7 days', exact: true }).getAttribute('aria-pressed')).toBe('true')
    } finally {
      releaseStale.resolve(undefined)
      if (!holdNext) await staleDone.promise
      await page.unroute('**/api/usage/get')
    }

    await page.route('**/api/usage/get', route => route.abort('failed'))
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Refresh failed.' }).waitFor()
    expect(await metric('Sessions').textContent()).toBe('1')
    await page.unroute('**/api/usage/get')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await idle()
    expect(await page.getByRole('alert').count()).toBe(0)

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'Usage statistics', exact: true }).click()
    await idle()
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
    await page.setViewportSize({ width: 640, height: 900 })
    await expect.poll(() => page.locator('[class*="sidebarCol"]').evaluate(element => element.getBoundingClientRect().width < 60)).toBe(true)
    await expect.poll(() => page.getByRole('dialog').evaluate((element) => {
      for (let ancestor: Element | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).opacity !== '1') return false
      }
      return true
    })).toBe(true)
    const dashboard = page.locator('[data-usage-statistics]')
    expect(await dashboard.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await page.locator('[data-usage-summary]').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
    const heatmap = page.getByRole('group', { name: 'Activity heatmap', exact: true })
    await heatmap.locator('[tabindex="0"]').focus()
    await page.keyboard.press('Home')
    expect(await heatmap.locator('rect').first().evaluate(element => element === document.activeElement)).toBe(true)

    await page.screenshot({ path: '.playwright-mcp/usage-statistics/dark.png', animations: 'disabled' })
    await page.locator('[data-usage-models]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.playwright-mcp/usage-statistics/dark-models.png', animations: 'disabled' })
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'thirty-days.expected.md', 'seven-days.expected.md',
    ])
  })
})
