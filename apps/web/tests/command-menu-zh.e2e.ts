// Keyless zh-coverage for the slash command menu's localized HOST rows.
// The shipped / command menu (ui-commands) renders host command descriptions
// through the `command` namespace description.* keys with a wire fallback;
// the English golden path (command-menu.expected.md) already pins the en
// surface, so this scenario advertises a zh browser and asserts the six
// localized rows appear without any English description residue. Zero model
// calls: the scaffold boots the shipped Web composition with credentials
// masked, and the menu settles entirely over the command directory pull.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Compact row: the option's accessible name joins name+description with a space (whitespace-normalized). */
const ZH_ROWS: ReadonlyArray<{ name: string; accessible: string }> = [
  { name: 'compact', accessible: 'compact 压缩较早的对话内容' },
  { name: 'export', accessible: 'export 将会话日志打包为 ZIP 压缩包下载' },
  { name: 'feedback', accessible: 'feedback 记录对本会话的反馈' },
  { name: 'goal', accessible: 'goal 设置或查看长任务的进行目标' },
  { name: 'permission', accessible: 'permission 切换权限预设（沙箱模式 + 审批策略）' },
  { name: 'plan', accessible: 'plan 进入或离开计划模式' },
]

/** The English descriptions each row must no longer show on the zh surface. */
const EN_DESCRIPTIONS = [
  'Compact older conversation history',
  'Download this Session log as a ZIP archive',
  'record feedback about this session',
  'set or view the goal for a long-running task',
  'Switch the permission preset (sandbox mode + approval policy)',
  'Enter or leave plan mode',
]

describe('web e2e: localized host command descriptions on the zh slash menu', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Keyless boot: the replay lane installs llm-deepseek disabled, so the
    // menu settles without a turn and no credential onboarding modal blocks
    // the workspace picker; the welcome notice is pre-acknowledged by the
    // scaffold.
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the slash menu on the zh surface with localized host rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-zh-command-menu'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    await input.click()
    // Reuse the established public path: the plus launcher opens the same
    // menu with only Command candidates, before the typed anchor.
    await page.getByRole('button', { name: '指令' }).click()
    const menu = page.getByRole('listbox', { name: '触发候选建议' })
    await menu.waitFor({ timeout: 10_000 })

    for (const row of ZH_ROWS) {
      await expect.poll(() => menu.getByRole('option', { name: row.accessible }).count(), { timeout: 10_000 })
        .toBe(1)
    }

    // The localized set is exactly the shipped host rows plus the client
    // `/model` contribution: assert no English description leaks onto any row.
    const all = (await menu.getByRole('option').allTextContents()).join('\n')
    for (const english of EN_DESCRIPTIONS) {
      expect(all).not.toContain(english)
    }

    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
