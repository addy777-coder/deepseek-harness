/** Real Electron/Utility Process smoke for the shipped Desktop profile. */
import { execFile, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import type {} from '../src/shared/contracts.ts'
import { assertNativeDirectoryPicker } from './native-directory-picker.ts'

if (process.platform !== 'win32') {
  console.log('desktop Electron e2e: skipped outside Windows')
  process.exit(0)
}

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(appDirectory, '..', '..')
const runtime = resolve(repository, '.dsh-build', 'desktop-runtime')
const packagedExecutable = process.env.DSH_DESKTOP_EXECUTABLE
const replayMode = process.env.DSH_DESKTOP_REPLAY === '1'
const liveMode = process.env.DSH_DESKTOP_LIVE === '1'
if (liveMode && (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '')) {
  throw new Error('desktop Electron e2e: DSH_DESKTOP_LIVE requires DEEPSEEK_API_KEY')
}
const replayFixture = resolve(repository, 'snapshots', 'session', 'pwsh-tool-turn', 'session.jsonl')
const toolPrompt = liveMode
  ? 'Reply with exactly DSH_DESKTOP_LIVE_OK and nothing else.'
  : replayMode
    ? "Use the pwsh tool to run exactly: [Console]::Out.Write('PWSH_OK'). Then reply with the single word DONE and stop."
    : "Use the pwsh tool to run exactly: Write-Output 'PWSH_OK'. Then reply with the single word DONE and stop."
const expectedReply = liveMode ? 'DSH_DESKTOP_LIVE_OK' : 'DONE'
const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-home-'))
const userData = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-user-'))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-workspace-'))
let application: ElectronApplication | undefined
let stderr = ''
let mockServer: MockLlmServer | undefined = replayMode || liveMode ? undefined : await startMockLlmServer({
  apiKey: 'desktop-e2e-key',
  sequence: ['tool_call_success', 'success'],
  toolName: 'pwsh',
  toolArguments: JSON.stringify({
    command: "Write-Output 'PWSH_OK'",
    description: 'Write PWSH_OK to console',
  }),
  successText: 'DONE',
})

interface ProcessRow {
  readonly ProcessId: number
  readonly ParentProcessId: number
  readonly CommandLine: string | null
}

function modelEnvironment(): Record<string, string> {
  if (liveMode) return { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }
  return replayMode
    ? { DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: replayFixture }
    : { DEEPSEEK_API_KEY: 'desktop-e2e-key', DEEPSEEK_BASE_URL: mockServer!.baseURL }
}

async function stageReplayProfile(): Promise<void> {
  const profile = join(home, 'profiles', 'desktop')
  const packageRoot = join(profile, 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
  const source = resolve(repository, 'packages', 'test-support', 'llm-replay')
  await mkdir(packageRoot, { recursive: true })
  await cp(join(source, 'lib'), join(packageRoot, 'lib'), { recursive: true })
  await cp(join(source, 'package.json'), join(packageRoot, 'package.json'))
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-llm-replay': `file:${source.replaceAll('\\', '/')}`,
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-gui-app',
          '@deepseek-ai/dsh-desktop-app',
        ],
        patchReload: 'startup',
      },
    },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

async function powershell(command: string): Promise<string> {
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  return await new Promise((resolvePromise, reject) => {
    execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, childStderr) => {
      if (error !== null) {
        reject(new Error(`desktop Electron e2e: process query failed: ${childStderr || error.message}`))
      } else {
        resolvePromise(stdout)
      }
    })
  })
}

async function descendantProcesses(parentPid: number): Promise<ProcessRow[]> {
  const output = (await powershell(
    `$all = @(Get-CimInstance Win32_Process); $frontier = @(${String(parentPid)}); $result = @(); `
    + 'for ($depth = 0; $depth -lt 5 -and $frontier.Count -gt 0; $depth++) { '
    + '$next = @($all | Where-Object { $frontier -contains $_.ParentProcessId }); '
    + '$result += $next; $frontier = @($next | ForEach-Object ProcessId) }; '
    + '$result | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  )).trim()
  if (output === '') return []
  const parsed = JSON.parse(output) as ProcessRow | ProcessRow[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function processExists(pid: number): Promise<boolean> {
  return (await powershell(
    `if (Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}') { 'yes' }`,
  )).trim() === 'yes'
}

async function tcpListenerCount(pid: number): Promise<number> {
  const output = (await powershell(
    `@((Get-NetTCPConnection -State Listen -OwningProcess ${String(pid)} -ErrorAction SilentlyContinue)).Count`,
  )).trim()
  return Number(output)
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`desktop Electron e2e: ${message}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
}

async function hostPid(parentPid: number, excluded?: number): Promise<number> {
  let observed: ProcessRow[] = []
  try {
    return await waitFor(async () => {
      observed = await descendantProcesses(parentPid)
      const row = observed.find(candidate =>
        candidate.ProcessId !== excluded
      && candidate.CommandLine?.includes('--utility-sub-type=node.mojom.NodeService') === true)
      return row?.ProcessId
    }, (value): value is number => value !== undefined, 'Host Utility Process did not appear')
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; children=${JSON.stringify(observed)}`)
  }
}

async function runSecondInstance(link: string): Promise<void> {
  const executable = packagedExecutable
    ?? resolve(appDirectory, 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = [
    ...(packagedExecutable === undefined ? [appDirectory] : []),
    '--lang=en-US',
    `--user-data-dir=${userData}`,
    link,
  ]
  await new Promise<void>((resolvePromise, reject) => {
    let childStderr = ''
    const child = spawn(executable, args, {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: home,
        ...modelEnvironment(),
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (chunk) => { childStderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('desktop Electron e2e: second instance did not exit'))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(
        `desktop Electron e2e: second instance failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`}) ${childStderr}`,
      ))
    })
  })
}

async function settleRendererIpc(
  page: Page,
  selected: string | null,
  notification?: { readonly sessionId: string; readonly title: string },
): Promise<void> {
  await page.evaluate(async ({ selection, notice }) => {
    window.dshDesktop.reportSelection(selection ?? undefined)
    await window.dshDesktop.bootstrap()
    if (notice !== undefined) window.dshDesktop.notifyTaskSettled(notice.sessionId, notice.title)
    await window.dshDesktop.bootstrap()
  }, { selection: selected, notice: notification })
}

async function notificationCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => {
    const notifications = Reflect.get(globalThis, '__dshE2eNotifications') as unknown[] | undefined
    return notifications?.length ?? 0
  })
}

async function writePluginFixture(
  directory: string,
  name: string,
  startupFailure: boolean,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  await writeFile(join(directory, 'index.js'), startupFailure
    ? "export function apply() { throw new Error('desktop e2e candidate startup failure') }\n"
    : 'export function apply() {}\n')
  await writeFile(join(directory, 'cordis.patch.yml'), startupFailure
    ? `- insert:\n    - id: desktop-e2e-failing-plugin\n      name: '${name}'\n`
    : '[]\n')
}

async function waitForReload(page: Page, marker: string): Promise<void> {
  await waitFor(
    async () => await page.evaluate(value => Reflect.get(globalThis, '__dshE2eReloadMarker') !== value, marker)
      .catch(() => false),
    Boolean,
    'window did not reload after Host replacement',
    45_000,
  )
  await page.getByText('DSH Desktop', { exact: true }).first().waitFor()
}

if (replayMode) await stageReplayProfile()
const modelPatch = replayMode ? `
- id: llm-deepseek
  disabled: true

- insert:
    - id: desktop-snapshot-llm-replay
      name: '@deepseek-ai/dsh-llm-replay'
      config:
        providers:
          - id: deepseek-official
            name: DeepSeek
            models:
              - id: deepseek-v4-pro

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
` : liveMode ? '' : `
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash-vision-exp
`
await writeFile(join(home, 'cordis.patch.yml'), `
- id: session-title-llm
  disabled: true

${modelPatch.trim()}

- id: desktop-directory-picker
  disabled: true

- id: desktop-directory-picker-ui
  disabled: true

- insert:
    - id: desktop-e2e-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'

    - id: desktop-e2e-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`.trimStart())

try {
  if (!replayMode) {
    await assertNativeDirectoryPicker(
      packagedExecutable ?? createRequire(import.meta.url)('electron') as string,
      packagedExecutable === undefined ? runtime : join(dirname(packagedExecutable), 'resources', 'runtime'),
    )
  }
  application = await electron.launch({
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
    args: [
      ...(packagedExecutable === undefined ? [appDirectory] : []),
      '--lang=en-US',
      `--user-data-dir=${userData}`,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      ...modelEnvironment(),
      ...(packagedExecutable === undefined && !replayMode ? { DSH_DESKTOP_RUNTIME_DIR: runtime } : {}),
    },
  })
  const mainPid = application.process().pid!
  application.process().stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  const main = await application.firstWindow({ timeout: 45_000 })
  try {
    await main.getByText('DSH Desktop', { exact: true }).first().waitFor()
  } catch (error) {
    console.error(`desktop Electron e2e: page text\n${await main.locator('body').innerText()}\nmain stderr\n${stderr}`)
    throw error
  }
  assert.equal(new URL(main.url()).protocol, 'file:')
  const initialHostPid = await hostPid(mainPid)
  assert.equal(await tcpListenerCount(initialHostPid), 0, 'Desktop Host must not open a TCP listener')
  const unaryProbe = await main.evaluate(async () => {
    const transport = Reflect.get(globalThis, '__DSH_TRANSPORT__') as {
      fetch(input: URL, init: RequestInit): Promise<Response>
    }
    const response = await transport.fetch(new URL('http://dsh.internal/api/desktop-e2e-probe'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(unaryProbe.status, 404)
  assert.match(unaryProbe.body, /not found/u)

  const continueOnboarding = main.getByRole('button', { name: /^(?:Continue|继续)$/u })
  await continueOnboarding.waitFor({ state: 'visible', timeout: 10_000 })
  await continueOnboarding.click()
  await continueOnboarding.waitFor({ state: 'detached', timeout: 10_000 })

  const connectedWorkspace = join(workspace, 'connected-workspace')
  await mkdir(connectedWorkspace)
  await main.getByRole('textbox', { name: /Choose workspace|选择工作区/u }).click()
  const chooser = main.getByRole('dialog', { name: /Select Workspace Directory|选择工作区目录/u })
  await chooser.waitFor({ timeout: 10_000 })
  await chooser.getByRole('button', { name: 'Edit path', exact: true }).click()
  const pathInput = chooser.getByRole('textbox', { name: 'Edit path', exact: true })
  await pathInput.fill(connectedWorkspace)
  await pathInput.press('Enter')
  const openWorkspace = chooser.getByRole('button', { name: 'Open', exact: true })
  try {
    await openWorkspace.waitFor({ state: 'visible', timeout: 10_000 })
    await waitFor(async () => openWorkspace.isEnabled(), Boolean, 'workspace Open button stayed disabled', 10_000)
  } catch (error) {
    throw new Error(`desktop Electron e2e: workspace chooser did not accept ${connectedWorkspace}: ${await chooser.innerText()}`, { cause: error })
  }
  await openWorkspace.click()
  const composer = main.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.waitFor({ timeout: 15_000 })
  await composer.fill(toolPrompt)
  await composer.press('Enter')
  try {
    await main.getByText(expectedReply, { exact: true }).waitFor({ timeout: liveMode ? 180_000 : 45_000 })
  } catch (error) {
    throw new Error(
      `desktop Electron e2e: tool round did not settle; requests=${JSON.stringify(mockServer?.requests ?? [])}; page=${await main.locator('body').innerText()}`,
      { cause: error },
    )
  }
  let exitHostPid = initialHostPid
  if (!liveMode) {
    const pwshRow = main.locator('[data-tool="pwsh"]').first()
    const owningTurn = await pwshRow.evaluate(element =>
      element.closest<HTMLElement>('[data-chat-turn]')?.dataset.chatTurn)
    if (owningTurn !== undefined && !await pwshRow.isVisible()) {
      const turnProcess = main.locator(`[data-turn-process="${owningTurn}"]`)
      await turnProcess.waitFor({ state: 'visible', timeout: 10_000 })
      if (await turnProcess.getAttribute('aria-expanded') !== 'true') await turnProcess.click()
    }
    await pwshRow.waitFor({ timeout: 20_000 })
    if (await pwshRow.getAttribute('aria-expanded') !== 'true') await pwshRow.click()
    const terminalCard = main.locator('[data-terminal]').first()
    await terminalCard.waitFor({ timeout: 20_000 })
    assert.match(await terminalCard.innerText(), /PWSH_OK/u)
    let currentSessionId: string
    if (replayMode) {
      const bootstrap = await main.evaluate(async () => await window.dshDesktop.bootstrap())
      assert.equal(typeof bootstrap.sessionId, 'string')
      currentSessionId = bootstrap.sessionId!
    } else {
      const firstServer = mockServer!
      assert.equal(firstServer.requests.length, 2, 'the tool round must consume two model requests')
      const selected = firstServer.requests[0]?.headers['x-deepseek-harness-session-id']
      assert.equal(typeof selected, 'string')
      currentSessionId = selected as string
      const captureDir = process.env.DSH_DESKTOP_HEADER_CAPTURE_DIR
      if (captureDir !== undefined && captureDir !== '') {
        const body = firstServer.requests[0]?.body as {
          messages?: Array<{ role?: unknown; content?: unknown }>
          tools?: Array<{ function?: unknown }>
        }
        const system = body.messages?.find(message => message.role === 'system')?.content
        assert.equal(typeof system, 'string')
        const tools = body.tools?.map(tool => tool.function)
        assert.ok(Array.isArray(tools))
        await mkdir(captureDir, { recursive: true })
        await writeFile(
          join(captureDir, 'system-prompt.expected.md'),
          `${(system as string).replaceAll(connectedWorkspace, '{{cwd}}')}\n`,
        )
        await writeFile(
          join(captureDir, 'tool-schemas.expected.json'),
          `${JSON.stringify({ initial: tools }, null, 2).replaceAll(connectedWorkspace, '{{cwd}}')}\n`,
        )
      }

      const mockPort = firstServer.port
      await firstServer.close()
      mockServer = await startMockLlmServer({
        port: mockPort,
        apiKey: 'desktop-e2e-key',
        sequence: ['tool_call_success', 'success'],
        toolName: 'pwsh',
        toolArguments: JSON.stringify({
          command: "Write-Output 'APPROVED_OK'",
          description: 'Exercise Desktop approval',
          sandbox_permissions: 'danger-full-access',
          justification: 'The Desktop E2E verifies the approval response path.',
        }),
        successText: 'APPROVAL_DONE',
      })
      await composer.fill('Request one approved PowerShell command, then reply with APPROVAL_DONE.')
      await composer.press('Enter')
      const approval = main.locator('[data-approval-key]')
      await approval.waitFor({ state: 'visible', timeout: 20_000 })
      await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      await main.getByText('APPROVAL_DONE', { exact: true }).waitFor({ timeout: 45_000 })
      assert.equal(mockServer.requests.length, 2, 'the approval round must consume two model requests')

      await mockServer.close()
      mockServer = await startMockLlmServer({
        port: mockPort,
        apiKey: 'desktop-e2e-key',
        sequence: ['success'],
        successText: 'IMAGE_DONE',
      })
      await main.evaluate(() => {
        const bytes = Uint8Array.from(atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ), value => value.charCodeAt(0))
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
        document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      })
      await main.getByAltText('pixel.png', { exact: true }).waitFor({ timeout: 10_000 })
      await composer.fill('Inspect the attached pixel and reply with IMAGE_DONE.')
      await composer.press('Enter')
      await main.getByText('IMAGE_DONE', { exact: true }).waitFor({ timeout: 45_000 })
      assert.equal(mockServer.requests.length, 1, 'the attachment round must consume one model request')
      assert.match(JSON.stringify(mockServer.requests[0]?.body), /image_url|data:image\/png/u)
    }

    const taskPromise = application.waitForEvent('window')
    await main.evaluate(async (sessionId) => { await window.dshDesktop.openSession(sessionId) }, currentSessionId)
    const task = await taskPromise
    try {
      await task.getByRole('button', { name: 'Return to main window', exact: true }).waitFor()
    } catch (error) {
      throw new Error(`desktop Electron e2e: task window ${task.url()} did not boot: ${await task.locator('body').innerText()}`, { cause: error })
    }
    await main.evaluate(async (sessionId) => { await window.dshDesktop.openSession(sessionId) }, currentSessionId)
    assert.equal(application.windows().length, 2, 'one Session must own at most one task window')
    await task.close()
    assert.equal(application.windows().length, 1, 'closing a task window must keep the main window alive')

    const link = `dsh://session/${Buffer.from(currentSessionId).toString('base64url')}`
    const deliveredLink = application.evaluate(({ app }) => new Promise<string[]>((resolvePromise, reject) => {
      const timer = setTimeout(() => { reject(new Error('second-instance event was not delivered')) }, 20_000)
      app.once('second-instance', (_event, argv) => {
        clearTimeout(timer)
        resolvePromise(argv)
      })
    }))
    await runSecondInstance(link)
    const deliveredArgv = await deliveredLink
    assert.equal(deliveredArgv.includes(link), true, `the second instance must forward its deep link: ${JSON.stringify(deliveredArgv)}`)
    const linkedTask = await waitFor(
      async () => application!.windows().find(window => window !== main),
      (value): value is Page => value !== undefined,
      'deep link did not open a task window',
    )
    try {
      await linkedTask.getByRole('button', { name: 'Return to main window', exact: true }).waitFor()
    } catch (error) {
      throw new Error(`desktop Electron e2e: deep-link window ${linkedTask.url()} did not boot: ${await linkedTask.locator('body').innerText()}`, { cause: error })
    }
    await runSecondInstance(link)
    assert.equal(application.windows().length, 2, 'duplicate deep links must reuse one task window')
    await linkedTask.close()

    await application.evaluate(({ Notification }) => {
      const notifications: object[] = []
      Reflect.set(globalThis, '__dshE2eNotifications', notifications)
      if (!Reflect.set(Notification, 'isSupported', () => true)
      || !Reflect.set(Notification.prototype, 'show', function (this: object) { notifications.push(this) })) {
        throw new Error('desktop Electron e2e: Notification hooks are not writable')
      }
    })
    await main.bringToFront()
    await waitFor(
      async () => await application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(window => window.isFocused())),
      Boolean,
      'main window did not receive focus',
    )
    await settleRendererIpc(main, 'desktop-e2e-notification', {
      sessionId: 'desktop-e2e-notification',
      title: 'Foreground task',
    })
    assert.equal(await notificationCount(application), 0, 'a focused Session window must suppress notifications')
    await settleRendererIpc(main, null, {
      sessionId: 'desktop-e2e-notification',
      title: 'Background task',
    })
    assert.equal(await notificationCount(application), 1, 'an unfocused Session must publish one notification')
    const notificationTaskPromise = application.waitForEvent('window')
    await application.evaluate(() => {
      const notifications = Reflect.get(globalThis, '__dshE2eNotifications') as Array<{ emit(event: string): void }>
      notifications.at(-1)?.emit('click')
    })
    const notificationTask = await notificationTaskPromise
    await notificationTask.getByRole('button', { name: 'Return to main window', exact: true }).waitFor()
    await notificationTask.close()

    if (!replayMode) {
      await application.evaluate(({ dialog }) => {
        if (!Reflect.set(dialog, 'showMessageBox', async () => ({ response: 0, checkboxChecked: false }))) {
          throw new Error('desktop Electron e2e: dialog hook is not writable')
        }
      })
      const safePlugin = join(workspace, 'safe-plugin')
      const failingPlugin = join(workspace, 'failing-plugin')
      await writePluginFixture(safePlugin, '@dsh-desktop-e2e/safe-plugin', false)
      await writePluginFixture(failingPlugin, '@dsh-desktop-e2e/failing-plugin', true)

      const installMarker = 'safe-install'
      await main.evaluate((value) => { Reflect.set(globalThis, '__dshE2eReloadMarker', value) }, installMarker)
      const installed = await main.evaluate(async (spec) => {
        const staged = await window.dshDesktop.stagePlugin({ action: 'install', spec })
        // A successful swap also reloads this Renderer; completion is the new
        // document observed below, not this execution context's IPC settlement.
        void window.dshDesktop.applyPlugin(staged.token).catch((error: unknown) => { console.error(error) })
        return staged.packages
      }, safePlugin)
      assert.equal(installed.some(plugin => plugin.name === '@dsh-desktop-e2e/safe-plugin'), true)
      await waitForReload(main, installMarker)
      const installedProfile = JSON.parse(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      assert.equal('@dsh-desktop-e2e/safe-plugin' in (installedProfile.dependencies ?? {}), true)

      const rollbackMarker = 'failed-install'
      await main.evaluate((value) => { Reflect.set(globalThis, '__dshE2eReloadMarker', value) }, rollbackMarker)
      await main.evaluate(async (spec) => {
        const staged = await window.dshDesktop.stagePlugin({ action: 'install', spec })
        // Rollback reloads this Renderer after the old Host becomes ready. Do not
        // make the soon-to-be-destroyed execution context own the IPC rejection.
        void window.dshDesktop.applyPlugin(staged.token).catch(() => {})
      }, failingPlugin)
      await waitForReload(main, rollbackMarker)
      const rolledBackProfile = JSON.parse(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      assert.equal('@dsh-desktop-e2e/safe-plugin' in (rolledBackProfile.dependencies ?? {}), true)
      assert.equal('@dsh-desktop-e2e/failing-plugin' in (rolledBackProfile.dependencies ?? {}), false)
    }

    const runningHostPid = replayMode ? initialHostPid : await hostPid(mainPid, initialHostPid)
    process.kill(runningHostPid)
    const failure = main.locator('.desktop-failure')
    await failure.waitFor({ state: 'visible', timeout: 20_000 })
    assert.match(await failure.innerText(), /DSH Host exited/u)
    await failure.getByRole('button', { name: /Restart Host|重启 Host/u }).click()
    await failure.waitFor({ state: 'detached', timeout: 45_000 })
    await main.getByText('DSH Desktop', { exact: true }).first().waitFor()
    const finalHostPid = await hostPid(mainPid, runningHostPid)
    exitHostPid = finalHostPid
  }

  await application.close()
  application = undefined
  await waitFor(async () => !(await processExists(exitHostPid)), Boolean, 'Host survived application exit')
  assert.doesNotMatch(stderr, /Object has been destroyed/u)
  console.log(
    `desktop Electron e2e: ${packagedExecutable === undefined ? 'source' : 'packaged'} ${liveMode ? 'real DeepSeek smoke' : replayMode ? 'recorded-session replay' : 'transport, model, tool, approval, attachment, terminal, windows, deep links, notifications, plugins, Host recovery'}, and graceful exit passed`,
  )
} catch (error) {
  console.error(`desktop Electron e2e: main stderr\n${stderr}`)
  throw error
} finally {
  if (application !== undefined) await application.close().catch(() => {})
  await mockServer?.close()
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(userData, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
  ])
}
