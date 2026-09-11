/** Desktop in-app update state machine; the electron-updater seam is injected. */
import type {
  DesktopUpdateProgress, DesktopUpdateState,
} from '../shared/contracts.ts'

/** Bounded wait for one update check; network stalls must not hang the UI. */
const CHECK_TIMEOUT_MS = 30_000

/** Update metadata surfaced from the feed after a successful check. */
export interface DesktopUpdateInfo {
  readonly version: string
  readonly releaseName: string | null
  readonly releaseNotes: string | null
}

/** One resolved update check: whether a newer build exists plus its metadata. */
export interface DesktopUpdateCheck {
  readonly isUpdateAvailable: boolean
  readonly info: DesktopUpdateInfo
}

/** The updater seam: default implementation lives in updater-runtime.ts. */
export interface DesktopUpdaterRuntime {
  /** Whether this build can run in-app updates (packaged with a feed). */
  isSupported(): boolean
  /** Version of the running Desktop build. */
  currentVersion(): string
  /** Query the update feed; resolves null when the updater is inactive. */
  checkForUpdates(): Promise<DesktopUpdateCheck | null>
  /** Download the update reported by the latest successful check. */
  downloadUpdate(onProgress: (progress: DesktopUpdateProgress) => void): Promise<void>
  /** Cancel the in-flight download; the downloadUpdate promise rejects as cancelled. */
  cancelDownload(): void
  /** Resolve when the installer requests app shutdown; reject an installation failure. */
  quitAndInstall(): Promise<void>
  /** Open the release notes page in the system browser. */
  openReleases(): void
  /** Ask the user to confirm the install; false declines. */
  confirmInstall(latestVersion: string): Promise<boolean>
}

/** Marker rejection for a user-cancelled download. */
export class DesktopUpdateCancelledError extends Error {
  constructor() {
    super('desktop update: download cancelled')
  }
}

function initialState(currentVersion: string): DesktopUpdateState {
  return {
    phase: 'idle',
    currentVersion,
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    progress: null,
    message: null,
  }
}

function unsupportedState(currentVersion: string): DesktopUpdateState {
  return {
    ...initialState(currentVersion),
    phase: 'unsupported',
  }
}

function errorState(previous: DesktopUpdateState, message: string): DesktopUpdateState {
  return {
    ...previous,
    phase: 'error',
    progress: null,
    message,
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (reason: unknown) => {
        clearTimeout(timer)
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      },
    )
  })
}

/**
 * Owner of the Desktop update lifecycle: check, download, cancel, install.
 *
 * Transitions happen only at commit points (a settled check/download or an
 * accepted install); every mutation replaces the snapshot wholesale and
 * notifies subscribers. `check` and `download` are single-flight; the caller
 * gets the in-flight promise instead of a second operation.
 */
export class DesktopUpdater {
  private state: DesktopUpdateState
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>()
  private checkFlight: Promise<DesktopUpdateState> | null = null
  private downloadFlight: Promise<DesktopUpdateState> | null = null

  /**
   * @param runtime - the electron-updater seam; tests replace it with fakes.
   */
  constructor(private readonly runtime: DesktopUpdaterRuntime) {
    this.state = runtime.isSupported()
      ? initialState(runtime.currentVersion())
      : unsupportedState(runtime.currentVersion())
  }

  /** Current snapshot. */
  snapshot(): DesktopUpdateState {
    return this.state
  }

  /**
   * Subscribe to state transitions; each notification carries the complete
   * new snapshot.
   * @param listener - transition observer.
   * @returns the disposer.
   */
  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Query the feed; resolves with the settled state snapshot. */
  async check(): Promise<DesktopUpdateState> {
    if (this.checkFlight !== null) return await this.checkFlight
    if (this.downloadFlight !== null) {
      throw new Error('desktop update: a download is in progress')
    }
    this.checkFlight = this.doCheck().finally(() => { this.checkFlight = null })
    return await this.checkFlight
  }

  /** Download the available update; resolves with the settled state snapshot. */
  async download(): Promise<DesktopUpdateState> {
    if (this.downloadFlight !== null) return await this.downloadFlight
    if (this.state.phase !== 'available') {
      throw new Error('desktop update: no update is available')
    }
    this.downloadFlight = this.doDownload().finally(() => { this.downloadFlight = null })
    return await this.downloadFlight
  }

  /** Cancel the in-flight download; the state returns to available. */
  cancel(): void {
    if (this.state.phase !== 'downloading') return
    this.runtime.cancelDownload()
  }

  /** Install the downloaded update after confirmation; quits the app on accept. */
  async install(): Promise<DesktopUpdateState> {
    if (this.state.phase !== 'downloaded') {
      throw new Error('desktop update: no update is downloaded')
    }
    if (!await this.runtime.confirmInstall(this.state.latestVersion ?? this.state.currentVersion)) {
      return this.state
    }
    this.patch({ phase: 'installing' })
    try {
      await this.runtime.quitAndInstall()
    } catch (reason) {
      return this.set(errorState(this.state, messageOf(reason)))
    }
    return this.state
  }

  /** Open the release notes page in the system browser. */
  openReleases(): void {
    this.runtime.openReleases()
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    const currentVersion = this.runtime.currentVersion()
    if (!this.runtime.isSupported()) return this.set(unsupportedState(currentVersion))
    this.patch({ phase: 'checking', message: null })
    try {
      const result = await withTimeout(
        this.runtime.checkForUpdates(),
        CHECK_TIMEOUT_MS,
        'desktop update: the update check timed out',
      )
      if (result === null) return this.set(unsupportedState(currentVersion))
      return this.set({
        ...initialState(currentVersion),
        phase: result.isUpdateAvailable ? 'available' : 'up-to-date',
        latestVersion: result.info.version,
        releaseName: result.info.releaseName,
        releaseNotes: result.info.releaseNotes,
      })
    } catch (reason) {
      return this.set(errorState(this.state, messageOf(reason)))
    }
  }

  private async doDownload(): Promise<DesktopUpdateState> {
    this.patch({ phase: 'downloading', progress: { percent: 0, transferred: 0, total: 0 }, message: null })
    try {
      await this.runtime.downloadUpdate((progress) => {
        if (this.state.phase === 'downloading') this.patch({ progress })
      })
      return this.set({ ...this.state, phase: 'downloaded', progress: null })
    } catch (reason) {
      if (reason instanceof DesktopUpdateCancelledError) {
        return this.set({ ...this.state, phase: 'available', progress: null })
      }
      return this.set(errorState(this.state, messageOf(reason)))
    }
  }

  private patch(mutator: Partial<DesktopUpdateState>): DesktopUpdateState {
    return this.set({ ...this.state, ...mutator })
  }

  private set(next: DesktopUpdateState): DesktopUpdateState {
    this.state = next
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch (error) {
        console.error('desktop update: subscriber failed:', error)
      }
    }
    return next
  }
}
