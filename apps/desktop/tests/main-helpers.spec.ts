import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deepLinkFromArgv,
  encodeSessionLink,
  parseDesktopDeepLink,
} from '../src/main/deep-link.ts'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  readDesktopPreferences,
  replaceGlobalShortcut,
  writeDesktopPreferences,
} from '../src/main/preferences.ts'
import {
  HOST_START_TIMEOUT_MS,
  waitForHostReadiness,
} from '../src/main/host-startup.ts'
import { DEFAULT_MAIN_BOUNDS, visibleWindowBounds } from '../src/main/window-state.ts'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop Host readiness', () => {
  it('uses the cold-start budget and reports the latest phase with stderr', async () => {
    vi.useFakeTimers()
    let phase: 'bootstrap' | 'profile' | 'loader' = 'bootstrap'
    const waiting = waitForHostReadiness(new Promise(() => {}), () => ({
      phase,
      stderrTail: ['profile warning\n'],
    }))
    const rejected = expect(waiting).rejects.toThrow([
      'desktop host: readiness timed out after 120 seconds during Loader settlement',
      'Host stderr:',
      'profile warning',
    ].join('\n'))
    expect(HOST_START_TIMEOUT_MS).toBe(120_000)
    phase = 'loader'
    await vi.advanceTimersByTimeAsync(HOST_START_TIMEOUT_MS)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the cold-start timer after readiness', async () => {
    vi.useFakeTimers()
    await waitForHostReadiness(Promise.resolve(), () => ({ phase: 'bootstrap', stderrTail: [] }))
    expect(vi.getTimerCount()).toBe(0)
  })
})

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-main-'))
  roots.push(root)
  return join(root, name)
}

describe('desktop deep links', () => {
  it('round-trips one opaque UTF-8 Session id through canonical base64url', () => {
    const link = encodeSessionLink('会话/opaque:id')
    expect(parseDesktopDeepLink(link)).toEqual({ kind: 'session', sessionId: '会话/opaque:id' })
    expect(deepLinkFromArgv(['electron.exe', '--flag', link])).toEqual({
      kind: 'session',
      sessionId: '会话/opaque:id',
    })
  })

  it.each([
    'dsh://new?prompt=hello',
    'dsh://new#fragment',
    'dsh://session/YQ/path',
    'dsh://session/YQ?workspace=C%3A%5Ctmp',
    'dsh://open/C:/tmp',
    'https://session/YQ',
  ])('rejects unsupported or data-bearing input %s', (input) => {
    expect(parseDesktopDeepLink(input)).toBeUndefined()
  })
})

describe('desktop preferences', () => {
  it('persists only one isolated preference document', async () => {
    const path = await temporaryPath('preferences.json')
    await writeDesktopPreferences(path, { globalShortcut: null, launchAtLogin: true })
    await expect(readDesktopPreferences(path)).resolves.toEqual({ globalShortcut: null, launchAtLogin: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ globalShortcut: null, launchAtLogin: true })
  })

  it('falls back for malformed files and invalid fields', async () => {
    const malformed = await temporaryPath('malformed.json')
    await writeFile(malformed, '{')
    await expect(readDesktopPreferences(malformed)).resolves.toEqual(DEFAULT_DESKTOP_PREFERENCES)

    const partial = await temporaryPath('partial.json')
    await writeFile(partial, JSON.stringify({ globalShortcut: 1, launchAtLogin: 'yes' }))
    await expect(readDesktopPreferences(partial)).resolves.toEqual(DEFAULT_DESKTOP_PREFERENCES)
  })

  it('reports shortcut conflicts and treats disabled configuration as available', () => {
    const unregisterAll = vi.fn()
    const callback = vi.fn()
    expect(replaceGlobalShortcut({ unregisterAll, register: () => false }, 'Ctrl+Shift+Space', callback)).toBe(false)
    expect(replaceGlobalShortcut({ unregisterAll, register: () => { throw new Error('invalid') } }, 'Bad', callback)).toBe(false)
    expect(replaceGlobalShortcut({ unregisterAll, register: vi.fn() }, null, callback)).toBe(true)
    expect(unregisterAll).toHaveBeenCalledTimes(3)
  })
})

describe('desktop window bounds', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }

  it('retains visible bounds and recovers an off-screen main window', () => {
    const visible = { x: 1800, y: 900, width: 900, height: 640 }
    expect(visibleWindowBounds(visible, [display])).toBe(visible)
    expect(visibleWindowBounds({ x: 4000, y: 3000, width: 900, height: 640 }, [display]))
      .toEqual(DEFAULT_MAIN_BOUNDS)
  })
})
