import type { DesktopWindowId } from '@deepseek-ai/dsh-desktop-transport'

/** Per-window bootstrap facts supplied by the Electron main process. */
export interface DesktopWindowBootstrap {
  readonly windowId: DesktopWindowId
  readonly kind: 'main' | 'task'
  readonly sessionId?: string
  readonly installed: boolean
  readonly version: string
  readonly hostError?: string
}

/** Low-frequency shell operations exposed through the context-isolated preload. */
export interface DesktopShellApi {
  bootstrap(): Promise<DesktopWindowBootstrap>
  openSession(sessionId: string): Promise<void>
  openMain(): Promise<void>
  newTask(): Promise<void>
  reportSelection(sessionId: string | undefined): void
  notifyTaskSettled(sessionId: string, title: string): void
  restartHost(): Promise<void>
  listPlugins(): Promise<readonly DesktopPluginInfo[]>
  stagePlugin(request: DesktopPluginRequest): Promise<DesktopPluginStage>
  applyPlugin(token: string): Promise<void>
  cancelPlugin(token: string): Promise<void>
  getPreferences(): Promise<DesktopPreferences>
  setPreference(request: DesktopPreferenceMutation): Promise<DesktopPreferences>
  getUpdateState(): Promise<DesktopUpdateState>
  checkForUpdate(): Promise<DesktopUpdateState>
  downloadUpdate(): Promise<DesktopUpdateState>
  installUpdate(): Promise<DesktopUpdateState>
  cancelUpdate(): Promise<DesktopUpdateState>
  openReleases(): Promise<void>
  onIntent(listener: (intent: { readonly type: 'new-task' }) => void): () => void
  onHostFailure(listener: (message: string) => void): () => void
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void
}

/** Desktop-main preferences and current shortcut availability. */
export interface DesktopPreferences {
  readonly globalShortcut: string | null
  readonly shortcutRegistered: boolean
  readonly launchAtLogin: boolean
  readonly launchAtLoginAvailable: boolean
}

/** One validated Desktop preference mutation. */
export type DesktopPreferenceMutation =
  | { readonly key: 'globalShortcut'; readonly value: string | null }
  | { readonly key: 'launchAtLogin'; readonly value: boolean }

/** One profile-managed plugin shown by the Desktop settings page. */
export interface DesktopPluginInfo {
  readonly name: string
  readonly version: string
  readonly spec: string
  readonly resolution: string
  readonly bundlePatch: string | null
  readonly clientBundle: 'verified' | 'missing' | 'not-declared'
}

/** One requested package-manager transaction. */
export type DesktopPluginRequest =
  | { readonly action: 'install'; readonly spec: string }
  | { readonly action: 'update' | 'remove'; readonly name: string }

/** Resolved transaction awaiting explicit application. */
export interface DesktopPluginStage {
  readonly token: string
  readonly action: DesktopPluginRequest['action']
  readonly packages: readonly DesktopPluginInfo[]
}

/** Update lifecycle phases of the Desktop in-app updater. */
export type DesktopUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

/** One byte-level progress sample of an update download. */
export interface DesktopUpdateProgress {
  readonly percent: number
  readonly transferred: number
  readonly total: number
}

/** Snapshot of the Desktop update state machine, mirrored into the renderer. */
export interface DesktopUpdateState {
  readonly phase: DesktopUpdatePhase
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly releaseName: string | null
  readonly releaseNotes: string | null
  readonly progress: DesktopUpdateProgress | null
  readonly message: string | null
}

declare global {
  interface Window {
    dshDesktop: DesktopShellApi
    __DSH_DESKTOP__?: DesktopWindowBootstrap
  }
}
