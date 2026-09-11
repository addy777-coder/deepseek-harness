import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateProgress } from '../src/shared/contracts.ts'
import {
  DesktopUpdateCancelledError,
  DesktopUpdater,
  type DesktopUpdaterRuntime,
} from '../src/main/updater.ts'

function makeRuntime(overrides: Partial<DesktopUpdaterRuntime> = {}): DesktopUpdaterRuntime {
  return {
    isSupported: () => true,
    currentVersion: () => '0.1.2-alpha.5',
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true,
      info: {
        version: '0.1.2-alpha.6',
        releaseName: 'DSH Desktop 0.1.2-alpha.6',
        releaseNotes: 'Fixed the fixture feed.',
      },
    })),
    downloadUpdate: vi.fn(async () => {}),
    cancelDownload: vi.fn(),
    quitAndInstall: vi.fn(async () => {}),
    openReleases: vi.fn(),
    confirmInstall: vi.fn(async () => true),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DesktopUpdater', () => {
  it('starts idle with the installed version', () => {
    const updater = new DesktopUpdater(makeRuntime())
    expect(updater.snapshot()).toMatchObject({
      phase: 'idle',
      currentVersion: '0.1.2-alpha.5',
      latestVersion: null,
      progress: null,
      message: null,
    })
  })

  it('reports unsupported builds without querying the feed', async () => {
    const checkForUpdates = vi.fn(async () => ({
      isUpdateAvailable: true,
      info: { version: '0.1.2-alpha.6', releaseName: null, releaseNotes: null },
    }))
    const updater = new DesktopUpdater(makeRuntime({ isSupported: () => false, checkForUpdates }))
    expect(updater.snapshot().phase).toBe('unsupported')
    await updater.check()
    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(updater.snapshot().phase).toBe('unsupported')
  })

  it('transitions to available and notifies subscribers on a newer feed version', async () => {
    const updater = new DesktopUpdater(makeRuntime())
    const seen = vi.fn()
    updater.subscribe(seen)
    await updater.check()
    expect(updater.snapshot()).toMatchObject({
      phase: 'available',
      latestVersion: '0.1.2-alpha.6',
      releaseName: 'DSH Desktop 0.1.2-alpha.6',
      releaseNotes: 'Fixed the fixture feed.',
    })
    expect(seen).toHaveBeenCalledWith(updater.snapshot())
  })

  it('reports up-to-date with the feed version when the feed is not newer', async () => {
    const checkForUpdates = vi.fn(async () => ({
      isUpdateAvailable: false,
      info: { version: '0.1.2-alpha.5', releaseName: null, releaseNotes: null },
    }))
    const updater = new DesktopUpdater(makeRuntime({ checkForUpdates }))
    await updater.check()
    expect(updater.snapshot().phase).toBe('up-to-date')
    expect(updater.snapshot().latestVersion).toBe('0.1.2-alpha.5')
  })

  it('fails loud on a check rejection', async () => {
    const checkForUpdates = vi.fn(async () => { throw new Error('feed unreachable') })
    const updater = new DesktopUpdater(makeRuntime({ checkForUpdates }))
    await updater.check()
    expect(updater.snapshot()).toMatchObject({ phase: 'error', message: 'feed unreachable' })
  })

  it('bounds one check by timeout', async () => {
    vi.useFakeTimers()
    const checkForUpdates = vi.fn(() => new Promise<never>(() => {}))
    const updater = new DesktopUpdater(makeRuntime({ checkForUpdates }))
    const check = updater.check()
    await vi.advanceTimersByTimeAsync(30_001)
    const state = await check
    expect(state.phase).toBe('error')
    expect(state.message).toContain('timed out')
  })

  it('is single-flight for concurrent checks', async () => {
    const checkForUpdates = vi.fn(async () => ({
      isUpdateAvailable: true,
      info: { version: '0.1.2-alpha.6', releaseName: null, releaseNotes: null },
    }))
    const updater = new DesktopUpdater(makeRuntime({ checkForUpdates }))
    const [first, second] = await Promise.all([updater.check(), updater.check()])
    expect(first).toBe(second)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('resolves download progress into the state and marks downloaded', async () => {
    const downloadUpdate = vi.fn(async (onProgress: (progress: DesktopUpdateProgress) => void) => {
      onProgress({ percent: 42, transferred: 42_000, total: 100_000 })
    })
    const updater = new DesktopUpdater(makeRuntime({ downloadUpdate }))
    await updater.check()
    await updater.download()
    expect(updater.snapshot()).toMatchObject({ phase: 'downloaded', progress: null })
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('refuses download without an available update', async () => {
    const updater = new DesktopUpdater(makeRuntime())
    await expect(updater.download()).rejects.toThrow('no update is available')
  })

  it('returns to available when the download is cancelled', async () => {
    let rejectDownload: (reason: unknown) => void = () => {}
    const downloadUpdate = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDownload = reject }))
    const cancelDownload = vi.fn(() => { rejectDownload(new DesktopUpdateCancelledError()) })
    const updater = new DesktopUpdater(makeRuntime({ downloadUpdate, cancelDownload }))
    await updater.check()
    const download = updater.download()
    updater.cancel()
    await download
    expect(updater.snapshot()).toMatchObject({ phase: 'available', latestVersion: '0.1.2-alpha.6' })
    expect(cancelDownload).toHaveBeenCalledTimes(1)
  })

  it('fails loud on a download rejection', async () => {
    const downloadUpdate = vi.fn(async () => { throw new Error('disk full') })
    const updater = new DesktopUpdater(makeRuntime({ downloadUpdate }))
    await updater.check()
    await updater.download()
    expect(updater.snapshot()).toMatchObject({ phase: 'error', message: 'disk full' })
  })

  it('rejects a check while a download is in flight', async () => {
    let rejectDownload: (reason: unknown) => void = () => {}
    const downloadUpdate = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDownload = reject }))
    const cancelDownload = vi.fn(() => { rejectDownload(new DesktopUpdateCancelledError()) })
    const updater = new DesktopUpdater(makeRuntime({ downloadUpdate, cancelDownload }))
    await updater.check()
    const download = updater.download()
    await expect(updater.check()).rejects.toThrow('a download is in progress')
    updater.cancel()
    await download
    expect(updater.snapshot().phase).toBe('available')
  })

  it('installs after confirmation and quits', async () => {
    const confirmInstall = vi.fn(async () => true)
    const quitAndInstall = vi.fn(async () => {})
    const updater = new DesktopUpdater(makeRuntime({ confirmInstall, quitAndInstall }))
    await updater.check()
    await updater.download()
    await updater.install()
    expect(confirmInstall).toHaveBeenCalledWith('0.1.2-alpha.6')
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.snapshot().phase).toBe('installing')
  })

  it('stays downloaded when the user declines the install', async () => {
    const confirmInstall = vi.fn(async () => false)
    const quitAndInstall = vi.fn(async () => {})
    const updater = new DesktopUpdater(makeRuntime({ confirmInstall, quitAndInstall }))
    await updater.check()
    await updater.download()
    const state = await updater.install()
    expect(state.phase).toBe('downloaded')
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('recovers to error when quitAndInstall rejects', async () => {
    const quitAndInstall = vi.fn(async () => { throw new Error('installer missing') })
    const updater = new DesktopUpdater(makeRuntime({ quitAndInstall }))
    await updater.check()
    await updater.download()
    await updater.install()
    expect(updater.snapshot()).toMatchObject({ phase: 'error', message: 'installer missing' })
  })

  it('refuses install without a downloaded update', async () => {
    const updater = new DesktopUpdater(makeRuntime())
    await updater.check()
    await expect(updater.install()).rejects.toThrow('no update is downloaded')
  })

  it('disposes the subscription', async () => {
    const updater = new DesktopUpdater(makeRuntime())
    const seen = vi.fn()
    const stop = updater.subscribe(seen)
    stop()
    await updater.check()
    expect(seen).not.toHaveBeenCalled()
  })

  it('never dispatches to a throwing subscriber', async () => {
    const updater = new DesktopUpdater(makeRuntime())
    const stop = updater.subscribe(() => { throw new Error('subscriber failed') })
    const seen = vi.fn()
    updater.subscribe(seen)
    await updater.check()
    expect(seen).toHaveBeenCalled()
    stop()
  })
})
