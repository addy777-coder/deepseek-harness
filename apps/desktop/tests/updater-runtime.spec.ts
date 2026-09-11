import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, autoUpdater as nativeUpdater, shell } from 'electron'
import electronUpdater, { CancellationToken } from 'electron-updater'
import { createDefaultUpdaterRuntime } from '../src/main/updater-runtime.ts'
import { DesktopUpdateCancelledError } from '../src/main/updater.ts'

vi.mock('electron', async () => ({
  app: { isPackaged: false, getVersion: () => '0.1.2-alpha.5' },
  autoUpdater: new (await import('node:events')).EventEmitter(),
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

vi.mock('electron-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron-updater')>()
  const { EventEmitter } = await import('node:events')
  return {
    CancellationToken: actual.CancellationToken,
    default: {
      CancellationToken: actual.CancellationToken,
      autoUpdater: Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(),
        downloadUpdate: vi.fn(),
        quitAndInstall: vi.fn(),
      }),
    },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createDefaultUpdaterRuntime', () => {
  it.each(['accepted', 'emitted-error', 'throw', 'timeout'] as const)(
    'settles installation on %s and removes both event listeners', async (outcome) => {
      vi.stubEnv('DSH_DESKTOP_UPDATE_FEED', undefined)
      vi.useFakeTimers()
      const autoUpdater = electronUpdater.autoUpdater
      const baseline = autoUpdater.listenerCount('error')
      const nativeBaseline = nativeUpdater.listenerCount('before-quit-for-update')
      vi.spyOn(autoUpdater, 'quitAndInstall').mockImplementation(() => {
        if (outcome === 'throw') throw new Error('installer failed')
        if (outcome === 'emitted-error') autoUpdater.emit('error', new Error('installer failed'))
        if (outcome === 'accepted') nativeUpdater.emit('before-quit-for-update')
      })
      const runtime = createDefaultUpdaterRuntime(() => undefined)
      const install = runtime.quitAndInstall()
      const assertion = outcome === 'accepted'
        ? expect(install).resolves.toBeUndefined()
        : expect(install).rejects.toThrow(outcome === 'timeout' ? 'did not request shutdown' : 'installer failed')
      try {
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
        await assertion
        expect(autoUpdater.listenerCount('error')).toBe(baseline)
        expect(nativeUpdater.listenerCount('before-quit-for-update')).toBe(nativeBaseline)
      } finally {
        await vi.runAllTimersAsync()
        await Promise.allSettled([install, assertion])
      }
    },
  )

  it('offers the fork release page for macOS distributions requiring manual installation', () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_FEED', undefined)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const packaged = Object.getOwnPropertyDescriptor(app, 'isPackaged')!
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue()
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
      const runtime = createDefaultUpdaterRuntime(() => undefined)
      expect(runtime.isSupported()).toBe(false)
      runtime.openReleases()
      expect(open).toHaveBeenCalledWith('https://github.com/addy777-coder/deepseek-harness/releases')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      Object.defineProperty(app, 'isPackaged', packaged)
    }
  })

  it('downloads again after cancellation and releases download listeners', async () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_FEED', undefined)
    const autoUpdater = electronUpdater.autoUpdater
    const updateInfo = {
      version: '0.1.2-alpha.6',
      files: [],
      path: 'fixture.exe',
      sha512: 'fixture-sha512',
      releaseDate: '2026-09-10T00:00:00Z',
    }
    vi.spyOn(autoUpdater, 'checkForUpdates').mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo,
      // oxlint-disable-next-line typescript/no-deprecated -- electron-updater still requires versionInfo in UpdateCheckResult.
      versionInfo: updateInfo,
      cancellationToken: new CancellationToken(),
    })
    const tokens: CancellationToken[] = []
    vi.spyOn(autoUpdater, 'downloadUpdate').mockImplementation((token = new CancellationToken()) => {
      tokens.push(token)
      return token.createPromise<string[]>((resolve) => {
        autoUpdater.emit('download-progress', {
          percent: 50, transferred: 50, total: 100, delta: 50, bytesPerSecond: 100,
        })
        if (tokens.length > 1) resolve(['fixture.exe'])
      })
    })
    const runtime = createDefaultUpdaterRuntime(() => undefined)
    const progress = vi.fn()
    await runtime.checkForUpdates()
    const first = runtime.downloadUpdate(progress)
    try {
      expect(autoUpdater.listenerCount('download-progress')).toBe(1)
      runtime.cancelDownload()
      await expect(first).rejects.toBeInstanceOf(DesktopUpdateCancelledError)
      expect(autoUpdater.listenerCount('download-progress')).toBe(0)
      expect(tokens[0]?.listenerCount('cancel')).toBe(0)

      await expect(runtime.downloadUpdate(progress)).resolves.toBeUndefined()
      expect(progress).toHaveBeenCalledTimes(2)
      expect(progress).toHaveBeenLastCalledWith({ percent: 50, transferred: 50, total: 100 })
      expect(autoUpdater.listenerCount('download-progress')).toBe(0)
      expect(tokens[1]?.listenerCount('cancel')).toBe(0)
      runtime.cancelDownload()
      expect(tokens[1]?.cancelled).toBe(false)
    } finally {
      runtime.cancelDownload()
      await Promise.allSettled([first])
    }
  })
})
