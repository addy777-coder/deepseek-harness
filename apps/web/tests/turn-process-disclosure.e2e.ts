/** Completed process disclosures over recorded and paginated Session history. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, parseSeedFixture,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/turn-tail-actions', import.meta.url))
const ARTIFACT_DIR = fileURLToPath(new URL('../../../.artifacts/turn-process-disclosure', import.meta.url))
const MODE = webSnapshotMode()
const HISTORY = createChatScrollFixture({
  markerPrefix: 'PROCESS', title: 'PROCESS paginated session', turns: 88,
})

describe.skipIf(MODE === 'record')('web e2e: completed process disclosure', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let prompt: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const recorded = await readFile(join(SNAPSHOT_DIR, 'session.jsonl'), 'utf8')
    prompt = fixtureUserPrompts(recorded)[0]!
    await seedSession(scaffold, recorded, 'process-recorded-history')
    await seedSession(scaffold, HISTORY.log, 'process-paged-history')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // Keep message dates on the recording's day across calendar-year changes.
    await page.clock.setFixedTime(new Date(Number(parseSeedFixture(recorded).header.createdAt)))
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="tree"][aria-label="Sessions"] [data-session-id]').first()
      .waitFor({ timeout: 30_000 })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'process disclosure cleanup failed')
  })

  async function openHistory(query: string): Promise<void> {
    const searchButton = page.getByRole('button', { name: 'Search sessions', exact: true })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(query)
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => results.count(), { timeout: 30_000 }).toBe(1)
    await results.first().click()
  }

  it('shows recorded thinking behind an elapsed-time disclosure and keeps the answer visible', async () => {
    await openHistory(prompt)
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    const process = page.locator('[data-turn-process]')
    await process.waitFor()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await process.textContent()).toMatch(/^Ran for \d+(?:m \d+)?s$/)
    const members = page.locator('[data-turn-process-member]')
    expect(await members.count()).toBeGreaterThan(0)
    for (const member of await members.all()) expect(await member.isVisible()).toBe(false)
    expect(await page.getByText('DONE', { exact: true }).isVisible()).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'history-collapsed.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd), MODE)

    await mkdir(ARTIFACT_DIR, { recursive: true })
    await writeFile(join(ARTIFACT_DIR, 'collapsed.aria.md'), await process.ariaSnapshot())
    await page.screenshot({ path: join(ARTIFACT_DIR, 'collapsed.png') })
    await process.focus()
    await page.keyboard.press('Enter')
    expect(await process.getAttribute('aria-expanded')).toBe('true')
    for (const member of await members.all()) expect(await member.isVisible()).toBe(true)
    expect(await page.getByText('DONE', { exact: true }).isVisible()).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'history-expanded.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd), MODE)
    await writeFile(join(ARTIFACT_DIR, 'expanded.aria.md'), await process.ariaSnapshot())
    await page.screenshot({ path: join(ARTIFACT_DIR, 'expanded.png') })
    await page.keyboard.press('Space')
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('starts paged Turns collapsed and preserves manual expansion when earlier history loads', async () => {
    await openHistory(HISTORY.markers.user(1))
    const answer = page.getByText(HISTORY.markers.assistant(HISTORY.turns), { exact: false }).first()
    await answer.waitFor({ timeout: 15_000 })
    const earlier = page.getByRole('button', { name: 'Load earlier', exact: true })
    await earlier.waitFor()
    const process = page.locator(`[data-turn-process="${HISTORY.turns}"]`)
    await process.waitFor()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await process.textContent()).toMatch(/^Ran for \d+(?:m \d+)?s$/)
    const members = page.locator(`[data-chat-turn="${HISTORY.turns}"][data-turn-process-member]`)
    expect(await members.count()).toBeGreaterThan(0)
    for (const member of await members.all()) expect(await member.isVisible()).toBe(false)
    expect(await answer.isVisible()).toBe(true)

    await process.click()
    expect(await process.getAttribute('aria-expanded')).toBe('true')
    for (const member of await members.all()) expect(await member.isVisible()).toBe(true)
    const previousRows = await page.locator('[data-chat-flow-key]').count()
    await earlier.click()
    await expect.poll(() => page.locator('[data-chat-flow-key]').count(), { timeout: 15_000 })
      .toBeGreaterThan(previousRows)
    expect(await process.getAttribute('aria-expanded')).toBe('true')
    for (const member of await members.all()) expect(await member.isVisible()).toBe(true)
    await process.click()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await answer.isVisible()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
