/** Default {@link DesktopUpdaterRuntime} backed by electron-updater and Electron. */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, autoUpdater as nativeUpdater, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron'
import electronUpdater, {
  type CancellationToken,
  type ProgressInfo,
  type UpdateCheckResult,
} from 'electron-updater'
import type { DesktopUpdateProgress } from '../shared/contracts.ts'
import {
  DesktopUpdateCancelledError,
  type DesktopUpdateInfo,
  type DesktopUpdaterRuntime,
} from './updater.ts'

const RELEASES_URL = 'https://github.com/addy777-coder/deepseek-harness/releases'

/** Test-only override: generic feed URL, forces the dev update config. */
const DEV_FEED_ENV = 'DSH_DESKTOP_UPDATE_FEED'

const UPDATER_CACHE_DIR = 'dsh-desktop-updater'
const INSTALL_TIMEOUT_MS = 30_000

const confirmCopy = {
  en: {
    title: 'DSH Desktop update',
    install: 'Install and restart',
    later: 'Later',
    message: (version: string) => `Install DSH Desktop ${version}?`,
    detail: 'The update is downloaded. DSH Desktop will close and reopen after installation.',
  },
  zh: {
    title: 'DSH Desktop 更新',
    install: '安装并重启',
    later: '稍后',
    message: (version: string) => `安装 DSH Desktop ${version}？`,
    detail: '更新包已下载完成，安装后 DSH Desktop 将关闭并重新打开。',
  },
} as const

function updateInfoOf(result: UpdateCheckResult): DesktopUpdateInfo {
  const info = result.updateInfo
  return {
    version: info.version,
    releaseName: info.releaseName ?? null,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
  }
}

function progressOf(info: ProgressInfo): DesktopUpdateProgress {
  return { percent: info.percent, transferred: info.transferred, total: info.total }
}

function feedOverride(): string | null {
  const value = process.env[DEV_FEED_ENV]
  if (value === undefined || value === '') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function confirmInstall(parent: BrowserWindow | undefined, latestVersion: string): Promise<boolean> {
  const text = app.getLocale().toLowerCase().startsWith('zh') ? confirmCopy.zh : confirmCopy.en
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: [text.install, text.later],
    defaultId: 0,
    cancelId: 1,
    title: text.title,
    message: text.message(latestVersion),
    detail: text.detail,
    noLink: true,
  }
  return parent === undefined
    ? dialog.showMessageBox(options).then(result => result.response === 0)
    : dialog.showMessageBox(parent, options).then(result => result.response === 0)
}

/**
 * Create the production variant of the updater seam.
 *
 * The dev-feed override (`DSH_DESKTOP_UPDATE_FEED`) makes an unpackaged build
 * check a generic feed through a userData `dev-app-update.yml`; the state
 * machine still reports `unsupported` when an update feed is not configured.
 * @param parentWindow - the confirm dialog's parent, when one exists.
 * @returns the electron-updater-backed runtime.
 */
export function createDefaultUpdaterRuntime(
  parentWindow: () => BrowserWindow | undefined,
): DesktopUpdaterRuntime {
  const autoUpdater = electronUpdater.autoUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.logger = null
  const feed = feedOverride()
  if (feed !== null) {
    autoUpdater.forceDevUpdateConfig = true
    const configPath = join(app.getPath('userData'), 'dev-app-update.yml')
    writeFileSync(
      configPath,
      `provider: generic\nurl: ${feed}\nupdaterCacheDirName: ${UPDATER_CACHE_DIR}\n`,
      'utf8',
    )
    autoUpdater.updateConfigPath = configPath
  }
  let downloadToken: CancellationToken | null = null
  return {
    // macOS distributions use ad-hoc signing and require a manual replacement.
    isSupported: () => process.platform === 'darwin' ? false : app.isPackaged
      ? existsSync(join(process.resourcesPath, 'app-update.yml'))
      : feed !== null,
    currentVersion: () => app.getVersion(),
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates()
      if (result === null) return null
      return { isUpdateAvailable: result.isUpdateAvailable, info: updateInfoOf(result) }
    },
    downloadUpdate: async (onProgress) => {
      const token = new electronUpdater.CancellationToken()
      downloadToken = token
      const progressListener = (info: ProgressInfo): void => { onProgress(progressOf(info)) }
      autoUpdater.on('download-progress', progressListener)
      try {
        await autoUpdater.downloadUpdate(token)
      } catch (reason) {
        if (token.cancelled) throw new DesktopUpdateCancelledError()
        throw reason
      } finally {
        downloadToken = null
        autoUpdater.off('download-progress', progressListener)
      }
    },
    cancelDownload: () => { downloadToken?.cancel() },
    quitAndInstall: () => new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        autoUpdater.off('error', failed)
        nativeUpdater.off('before-quit-for-update', quitting)
      }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const quitting = (): void => { cleanup(); resolve() }
      const timer = setTimeout(() => {
        failed(new Error('desktop update: the installer did not request shutdown'))
      }, INSTALL_TIMEOUT_MS)
      // BaseUpdater emits installation failures and signals accepted shutdown on Electron's updater.
      autoUpdater.on('error', failed)
      nativeUpdater.on('before-quit-for-update', quitting)
      try {
        autoUpdater.quitAndInstall(true, true)
      } catch (reason) {
        failed(reason instanceof Error ? reason : new Error(String(reason)))
      }
    }),
    openReleases: () => {
      void shell.openExternal(RELEASES_URL).catch((error: unknown) => { console.error(error) })
    },
    confirmInstall: latestVersion => confirmInstall(parentWindow(), latestVersion),
  }
}
