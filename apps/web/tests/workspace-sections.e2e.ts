/** Sidebar placement through the shipped Web composition, two browser contexts, and a Host restart. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  seedSession, webSnapshotMode, type LaunchOptions, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../../../snapshots/web/workspace-sections/', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url))

describe('web e2e: custom sidebar sections', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let peer: Page
  let world: string
  let options: LaunchOptions
  let projectId: WorkspaceId
  let sessionId: SessionId
  let otherSessionId: SessionId
  let recorded: Awaited<ReturnType<typeof readPersistedEvents>>

  async function openPage(): Promise<Page> {
    const next = await newEnglishPage(browser)
    await next.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await next.getByRole('button', { name: 'New section', exact: true }).waitFor()
    return next
  }

  async function createSection(title: string): Promise<void> {
    await page.getByRole('button', { name: 'New section', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New section', exact: true })
    await dialog.getByRole('textbox', { name: 'Section name', exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'New section', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await peer.getByRole('button', { name: title.trim(), exact: true }).waitFor()
  }

  beforeAll(async () => {
    world = await realpath(await mkdtemp(join(tmpdir(), 'dsh-section-restart-')))
    const workspaceCwd = join(world, 'project')
    const persistenceRoot = join(world, 'sessions')
    await mkdir(workspaceCwd)
    await mkdir(persistenceRoot)
    await writeFile(join(workspaceCwd, 'keep.txt'), 'kept\n')
    options = { workspaceCwd, persistenceRoot, harnessHome: join(world, 'home') }
    scaffold = await launchWebScaffold(options)
    const seed = await readFile(SEED, 'utf8')
    sessionId = await seedSession(scaffold, seed, 'section-session-one')
    otherSessionId = await seedSession(scaffold, seed, 'section-session-two')
    const project = await scaffold.ctx.workspaceRegistry.create(workspaceCwd)
    await project.setTitle('Section project')
    projectId = project.id
    await project.attachSession(sessionId)
    await project.attachSession(otherSessionId)
    recorded = await readPersistedEvents(scaffold, sessionId)
    browser = await chromium.launch()
    page = await openPage()
    peer = await openPage()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (world !== undefined) await rm(world, { recursive: true, force: true })
  })

  it('synchronizes project/session placement and preserves it across reload and restart', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-sections'))
    await createSection(' Work ')
    await createSection('Personal')
    const work = scaffold.ctx.workspaceRegistry.layout.sections.find(section => section.title === 'Work')!
    const personal = scaffold.ctx.workspaceRegistry.layout.sections.find(section => section.title === 'Personal')!
    const project = page.locator(`[data-workspace-id="${projectId}"] > span [role="treeitem"]`).first()
    await project.dragTo(page.getByRole('button', { name: 'Work', exact: true }))
    await expect.poll(() => scaffold.ctx.workspaceRegistry.layout.sections[0]?.workspaceIds).toEqual([projectId])
    await peer.locator(`[data-sidebar-section="${work.id}"] [data-workspace-id="${projectId}"]`).waitFor()
    const projectRow = page.locator(`[data-workspace-id="${projectId}"]`).getByRole('treeitem').first()
    if (await projectRow.getAttribute('aria-expanded') !== 'true') await projectRow.click()

    const session = page.locator(`[data-session-id="${sessionId}"]`)
    await session.dragTo(page.getByRole('button', { name: 'Personal', exact: true }))
    await expect.poll(() => scaffold.ctx.workspaceRegistry.layout.sections[1]?.sessionIds).toEqual([sessionId])
    await peer.locator(`[data-sidebar-section="${personal.id}"] [data-session-id="${sessionId}"]`).waitFor()
    expect(await page.locator(`[data-session-id="${sessionId}"]`).count()).toBe(1)
    expect(await page.locator(`[data-workspace-id="${projectId}"] [data-session-id="${sessionId}"]`).count()).toBe(0)
    expect(scaffold.ctx.workspaceRegistry.get(projectId)?.sessionIds).toContain(sessionId)

    await page.locator(`[data-session-id="${otherSessionId}"]`).dragTo(page.getByRole('button', { name: 'Personal', exact: true }))
    await expect.poll(() => scaffold.ctx.workspaceRegistry.layout.sections[1]?.sessionIds).toEqual([sessionId, otherSessionId])
    await page.locator(`[data-session-id="${otherSessionId}"]`).dragTo(page.locator(`[data-session-id="${sessionId}"]`), { targetPosition: { x: 8, y: 2 } })
    await expect.poll(() => scaffold.ctx.workspaceRegistry.layout.sections[1]?.sessionIds).toEqual([otherSessionId, sessionId])

    const heading = page.getByRole('button', { name: 'Personal', exact: true })
    await heading.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('false')
    expect(await peer.getByRole('button', { name: 'Personal', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.getByRole('button', { name: 'Personal', exact: true }).getAttribute('aria-expanded')).toBe('false')
    await page.getByRole('button', { name: 'Personal', exact: true }).click()
    await compareOrRefreshGolden(join(FIXTURE_DIR, 'sidebar.expected.md'),
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.screenshot({ path: join(process.cwd(), '.playwright-mcp/workspace-sections.png'), animations: 'disabled' })

    // The default area folds through the same heading control as a custom
    // section, and its fold is browser-local: it survives a reload while the
    // durable sections keep their own states.
    await page.getByRole('button', { name: 'Unsectioned', exact: true }).click()
    await expect.poll(
      () => page.getByRole('button', { name: 'Unsectioned', exact: true }).getAttribute('aria-expanded'),
    ).toBe('false')
    await expect.poll(() => page.getByText('Drop a project or session here', { exact: true }).count()).toBe(0)
    await page.reload({ waitUntil: 'load' })
    await expect.poll(
      () => page.getByRole('button', { name: 'Unsectioned', exact: true }).getAttribute('aria-expanded'),
      { timeout: 15_000 },
    ).toBe('false')
    expect(await page.getByRole('button', { name: 'Work', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await page.getByRole('button', { name: 'Unsectioned', exact: true }).click()

    const saved = structuredClone(scaffold.ctx.workspaceRegistry.layout)
    await page.context().close()
    await peer.context().close()
    await scaffold.close()
    scaffold = await launchWebScaffold(options)
    expect(scaffold.ctx.workspaceRegistry.layout).toEqual(saved)
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(recorded)
    page = await openPage()
    await page.locator(`[data-session-id="${sessionId}"]`).click()
    await expect.poll(() => page.locator('[data-chat-turn]').count()).toBeGreaterThan(0)
    expect((await scaffold.ctx.sessionPersistence.list()).find(item => item.header.id === sessionId)?.header.cwd).toBe(options.workspaceCwd)

    for (const name of ['Personal', 'Work']) {
      await page.getByRole('button', { name: `Section actions for ${name}`, exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete section', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete section', exact: true })
      expect(await dialog.textContent()).toContain('Files and session histories will be kept')
      await dialog.getByRole('button', { name: 'Delete section', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    expect(scaffold.ctx.workspaceRegistry.layout.sections).toEqual([])
    expect(scaffold.ctx.workspaceRegistry.get(projectId)?.sessionIds).toContain(sessionId)
    expect(await readFile(join(scaffold.workspaceCwd, 'keep.txt'), 'utf8')).toBe('kept\n')
  })
})
