/** Recorded-session replay through the Windows Desktop Electron carrier. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..', '..')
const desktopEntry = resolve(repository, 'apps', 'desktop', 'lib', 'main.js')
const replayEntry = resolve(repository, 'packages', 'test-support', 'llm-replay', 'lib', 'index.js')
const driver = resolve(repository, 'apps', 'desktop', 'tests', 'electron.e2e.ts')
const runnable = process.platform === 'win32' && existsSync(desktopEntry) && existsSync(replayEntry)

it.skipIf(!runnable)('replays a recorded PowerShell tool round through Electron MessagePort IPC', async () => {
  const env = { ...process.env, DSH_DESKTOP_REPLAY: '1' }
  delete env.DSH_DESKTOP_EXECUTABLE
  const result = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolveResult, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, ['--import', 'tsx/esm', driver], {
      cwd: repository,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => { resolveResult({ code, stdout, stderr }) })
  })
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('source recorded-session replay')
}, 110_000)
