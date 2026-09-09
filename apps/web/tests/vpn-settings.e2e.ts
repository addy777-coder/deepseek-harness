/** Desktop VPN settings over the real browser carrier, with only native helper I/O scripted. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-vpn-controller'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ScriptedChild } from '../../../packages/network/network-openvpn/tests/process-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold } from './scaffold.ts'

const OVERLAY = fileURLToPath(new URL('./vpn-settings.overlay.yml', import.meta.url))
const INSTALL_ANCHOR = fileURLToPath(new URL('../../../packages/bundle/desktop-app/package.json', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/vpn-settings/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.playwright-mcp/', import.meta.url))
const MODE = webSnapshotMode()
const profile = { name: 'company.ovpn', mimeType: 'text/plain', buffer: Buffer.from('client\nauth-user-pass\nca company-ca.crt\n') }
const certificate = { name: 'company-ca.crt', mimeType: 'text/plain', buffer: Buffer.from('synthetic certificate') }

describe('web e2e: desktop VPN settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let directory: string
  let shots: string
  let processes: { children: ScriptedChild[]; spawns: SubprocessSpawnSpec[] }
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-gui-'))
    const executablePath = join(directory, 'helper.exe')
    const executable = 'synthetic VPN image; execution is owned by ScriptedProcesses'
    await writeFile(executablePath, executable)
    await mkdir(ARTIFACTS, { recursive: true })
    shots = await mkdtemp(join(ARTIFACTS, 'vpn-settings-'))
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [INSTALL_ANCHOR] })
    const internal = scaffold.ctx.loader.internal
    if (!internal) throw new Error('VPN GUI fixture requires the application module loader')
    const provider = await internal.import('@deepseek-ai/dsh-network-openvpn',
      pathToFileURL(INSTALL_ANCHOR).href, {}) as typeof import('@deepseek-ai/dsh-network-openvpn')
    const subprocess = await internal.import('@deepseek-ai/dsh-subprocess',
      new URL('../../../packages/network/network-openvpn/package.json', import.meta.url).href, {}) as typeof import('@deepseek-ai/dsh-subprocess')
    class PortableNetwork extends provider.OpenVpnNetwork {
      protected override supportsHost(): boolean { return true }
    }
    class FixtureProcesses extends subprocess.SubprocessRuntime {
      readonly children: ScriptedChild[] = []
      readonly spawns: SubprocessSpawnSpec[] = []
      constructor(ctx: Context) {
        super(ctx)
        processes = { children: this.children, spawns: this.spawns }
        ctx.effect(() => async () => {
          for (const child of this.children) { child.exit(0); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() }
          await Promise.allSettled(this.children.map(child => child.done))
        })
      }
      resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }
      spawnTerminal(): Promise<never> { return Promise.reject(new Error('VPN GUI fixture has no terminal')) }
      spawn(spec: SubprocessSpawnSpec): ScriptedChild {
        const child = new ScriptedChild()
        this.children.push(child)
        this.spawns.push(spec)
        queueMicrotask(() => {
          const bootstrap = JSON.parse(child.input) as { evaluateOnly?: boolean; password?: string }
          if (bootstrap.evaluateOnly) {
            child.emit({ event: 'profile-evaluated', accepted: true })
            child.exit(0)
          } else if (bootstrap.password === 'synthetic-valid-password') {
            child.emit({ event: 'proxy-ready', port: 1 })
          } else {
            child.emit({ event: 'AUTH_FAILED', error: true })
            child.exit(1)
          }
        })
        return child
      }
    }
    scaffold.ctx.loader.builtins['vpn-settings-fixture'] = {
      inject: ['settings', 'credentials', 'subprocess'],
      async apply(ctx: Context) {
        const isolated = ctx.isolate('subprocess')
        await isolated.plugin(FixtureProcesses).await()
        await isolated.plugin(PortableNetwork, { executablePath,
          executableSha256: createHash('sha256').update(executable).digest('hex'),
          dshHome: directory, shutdownGraceMs: 100 }).await()
      },
    }
    await scaffold.ctx.loader.create({ name: 'cordis:vpn-settings-fixture' })
    await scaffold.ctx.loader.await()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'VPN', exact: true }).click()
    await page.locator('[data-vpn-settings][aria-busy="false"]').waitFor()
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { if (directory) await rm(directory, { recursive: true, force: true }) }
    }
  })

  async function idle(): Promise<void> {
    await expect.poll(() => page.locator('[data-vpn-settings]').getAttribute('aria-busy'), { timeout: 10_000 }).toBe('false')
  }

  async function status(value: string): Promise<void> {
    await expect.poll(() => page.getByRole('status', { name: 'VPN status', exact: true }).textContent(), { timeout: 10_000 }).toBe(value)
  }

  async function golden(name: string): Promise<void> {
    const aria = await captureStableAria(page, '[data-vpn-settings]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`), aria, MODE)
  }

  it('imports credentials, connects, recovers from authentication failure, and disconnects without exposing passwords', async () => {
    onTestFailed(async () => {
      await page.screenshot({ path: join(shots, 'failure.png'), animations: 'disabled' })
      console.error('VPN GUI fixture state:', await scaffold.ctx.network.get(), { helperCount: processes.children.length })
    })
    await status('Not configured')
    await golden('unconfigured')
    await page.getByLabel('VPN profile', { exact: true }).setInputFiles(profile)
    await page.getByLabel('VPN username', { exact: true }).fill('employee')
    await page.getByLabel('VPN password', { exact: true }).fill('synthetic-valid-password')
    await page.getByRole('checkbox', { name: 'Connect automatically at startup', exact: true }).check()
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await idle()
    expect(await page.getByRole('alert').allTextContents()).toEqual([
      'A referenced file is missing. Select the .ovpn profile again and include its certificates or keys.',
    ])
    expect((await scaffold.ctx.vpnController.get()).passwordConfigured).toBe(false)
    await page.getByLabel('Certificates and referenced files', { exact: true }).setInputFiles(certificate)
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await idle()
    expect(await page.getByRole('alert').allTextContents()).toEqual([])
    await status('Connected')
    await idle()
    expect(await page.getByLabel('VPN password', { exact: true }).inputValue()).toBe('')
    const saved = await scaffold.ctx.vpnController.get()
    expect(saved).toMatchObject({ profileName: 'company.ovpn', username: 'employee', autoConnect: true, passwordConfigured: true })
    expect(JSON.stringify(saved)).not.toContain('synthetic-valid-password')
    expect(JSON.stringify(scaffold.ctx.settings.describe())).not.toContain('synthetic-valid-password')
    expect(JSON.stringify(processes.spawns)).not.toContain('synthetic-valid-password')
    await golden('connected')
    await page.screenshot({ path: join(shots, 'connected-light.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await status('Connected')
    await idle()
    expect((await scaffold.ctx.vpnController.get()).passwordConfigured).toBe(true)
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await status('Disconnected')
    await idle()
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await status('Connected')
    await idle()
    await page.getByLabel('VPN password', { exact: true }).fill('synthetic-invalid-password')
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'The VPN username or password is incorrect.' }).waitFor()
    await idle()
    expect(await page.getByLabel('VPN password', { exact: true }).inputValue()).toBe('')
    await golden('authentication-failed')
    await page.getByLabel('VPN password', { exact: true }).fill('synthetic-valid-password')
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    await status('Connected')
    await idle()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.getByRole('button', { name: 'VPN', exact: true }).click()
    await idle()
    await page.setViewportSize({ width: 640, height: 1300 })
    await expect.poll(() => page.locator('[class*="sidebarCol"]').evaluate(element => element.getBoundingClientRect().width < 60)).toBe(true)
    await expect.poll(() => page.getByRole('dialog').evaluate((element) => {
      for (let parent: Element | null = element; parent !== null; parent = parent.parentElement) {
        if (getComputedStyle(parent).opacity !== '1') return false
      }
      return true
    })).toBe(true)
    const section = page.locator('[data-vpn-settings]')
    expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(shots, 'connected-dark-narrow.png'), animations: 'disabled' })
    const save = page.getByRole('button', { name: 'Save and connect', exact: true })
    await save.scrollIntoViewIfNeeded()
    expect(await save.isVisible()).toBe(true)
    await page.screenshot({ path: join(shots, 'connected-dark-controls.png'), animations: 'disabled' })
    expect(tripwire.pageErrors).toEqual([])
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await status('Disconnected')
    await idle()
    await Promise.all(processes.children.map(child => child.done))
    expect(processes.children.every(child => child.waitForExitCalls > 0)).toBe(true)
    console.log(`VPN settings screenshots: ${shots}`)
  })
})
