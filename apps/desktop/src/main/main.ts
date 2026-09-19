/** Electron main process for DSH Desktop. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import type { DesktopWindowId } from '@deepseek-ai/dsh-desktop-transport'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  DesktopIntent, DesktopPreferenceMutation, DesktopPreferences, DesktopWindowBootstrap,
} from '../shared/contracts.ts'
import { channels } from './channels.ts'
import { deepLinkFromArgv, type DesktopDeepLink } from './deep-link.ts'
import { DesktopHostProcess } from './host-process.ts'
import { DesktopPluginManager, parseDesktopPluginRequest } from './plugin-manager.ts'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  readDesktopPreferences,
  replaceGlobalShortcut,
  type StoredDesktopPreferences,
  writeDesktopPreferences,
} from './preferences.ts'
import { DesktopUpdater } from './updater.ts'
import { createDefaultUpdaterRuntime } from './updater-runtime.ts'
import { readWindowBounds, visibleWindowBounds, writeWindowBounds } from './window-state.ts'

const PRODUCT_NAME = 'DSH Desktop'

const localeCopy = {
  en: {
    show: 'Show DSH Desktop',
    newTask: 'New task',
    quit: 'Quit',
    completed: 'Task finished',
  },
  zh: {
    show: '显示 DSH Desktop',
    newTask: '新建任务',
    quit: '退出',
    completed: '任务已结束',
  },
} as const

interface WindowRecord {
  readonly id: DesktopWindowId
  readonly window: BrowserWindow
  sessionId: string | undefined
  intentReady: boolean
  pendingIntent: DesktopIntent | undefined
}

let mainWindow: WindowRecord | undefined
const windowsByWebContents = new Map<number, WindowRecord>()
let tray: Tray | undefined
let hostReady = false
let hostError: string | undefined
let quitting = false
let preferences: StoredDesktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES }
let shortcutRegistered = false
let launchAtLoginAvailable = false
let pendingSecondInstance: DesktopDeepLink | null | undefined

const boundsPath = (): string => join(app.getPath('userData'), 'window-state.json')
const preferencesPath = (): string => join(app.getPath('userData'), 'preferences.json')
const copy = () => app.getLocale().toLowerCase().startsWith('zh') ? localeCopy.zh : localeCopy.en

function icon() {
  return nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png'))
}

function rendererPath(): string {
  return join(app.getAppPath(), 'dist', 'index.html')
}

function preloadPath(): string {
  return join(app.getAppPath(), 'lib', 'preload.cjs')
}

function openExternalIfHttp(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(parsed.href).catch((error: unknown) => { console.error(error) })
    }
  } catch {
    // Chromium supplied an invalid target; the caller still denies navigation.
  }
}

function recordForSender(event: IpcMainInvokeEvent | IpcMainEvent): WindowRecord {
  const record = windowsByWebContents.get(event.sender.id)
  if (record === undefined || record.window.isDestroyed()) {
    throw new Error('desktop shell: request came from an unknown window')
  }
  return record
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
}

function configureNavigation(window: BrowserWindow): void {
  window.webContents.on('console-message', (event) => {
    const write = event.level === 'error' ? console.error : event.level === 'warning' ? console.warn : console.log
    write(`[desktop renderer] ${event.message}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`desktop renderer failed to load ${url}: ${String(code)} ${description}`)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    openExternalIfHttp(url)
  })
}

function registerWindow(record: WindowRecord): void {
  const webContentsId = record.window.webContents.id
  windowsByWebContents.set(webContentsId, record)
  configureNavigation(record.window)
  record.window.webContents.on('did-start-loading', () => { record.intentReady = false })
  record.window.webContents.on('did-finish-load', () => {
    if (!hostReady || record.window.isDestroyed()) return
    try {
      host.attach(record.window, record.id)
    } catch (error) {
      broadcastHostFailure(error instanceof Error ? error.message : String(error))
    }
  })
  record.window.on('closed', () => {
    windowsByWebContents.delete(webContentsId)
    if (mainWindow === record) {
      mainWindow = undefined
    }
  })
}

async function createMainWindow(): Promise<WindowRecord> {
  const stored = await readWindowBounds(boundsPath())
  const bounds = visibleWindowBounds(stored, screen.getAllDisplays().map(display => display.workArea))
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: PRODUCT_NAME,
    icon: icon(),
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: '#00000000', symbolColor: '#6b7280', height: 40 },
    }),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  const record: WindowRecord = {
    id: randomUUID() as DesktopWindowId,
    window,
    sessionId: undefined,
    intentReady: false,
    pendingIntent: undefined,
  }
  mainWindow = record
  registerWindow(record)
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void quitDesktop()
  })
  await window.loadFile(rendererPath())
  return record
}

function focusMain(intent?: DesktopIntent): void {
  const record = mainWindow
  if (record === undefined || record.window.isDestroyed()) return
  if (record.window.isMinimized()) record.window.restore()
  record.window.show()
  record.window.focus()
  if (intent === undefined) return
  if (record.intentReady) record.window.webContents.send(channels.intent, intent)
  else record.pendingIntent = intent
}

function focusMainWithNewTask(): void {
  focusMain({ type: 'new-task' })
}

function routeDeepLink(link: DesktopDeepLink | undefined): void {
  if (link === undefined) {
    focusMain()
    return
  }
  if (link.kind === 'new') {
    focusMainWithNewTask()
    return
  }
  focusMain({ type: 'open-session', sessionId: link.sessionId as SessionId })
}

function routeSecondInstance(argv: readonly string[]): void {
  const link = deepLinkFromArgv(argv) ?? null
  if (mainWindow === undefined) {
    pendingSecondInstance = link
    return
  }
  routeDeepLink(link ?? undefined)
}

function createTray(): void {
  tray = new Tray(icon().resize({ width: 20, height: 20 }))
  tray.setToolTip(PRODUCT_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy().show, click: () => { mainWindow?.window.show(); mainWindow?.window.focus() } },
    { label: copy().newTask, click: focusMainWithNewTask },
    { type: 'separator' },
    { label: copy().quit, click: () => { void quitDesktop() } },
  ]))
  tray.on('double-click', () => { mainWindow?.window.show(); mainWindow?.window.focus() })
}

function applyGlobalShortcut(): void {
  shortcutRegistered = replaceGlobalShortcut(globalShortcut, preferences.globalShortcut, focusMainWithNewTask)
  if (!shortcutRegistered) console.warn(`DSH Desktop could not register ${preferences.globalShortcut}`)
}

function preferenceSnapshot(): DesktopPreferences {
  return {
    globalShortcut: preferences.globalShortcut,
    shortcutRegistered,
    launchAtLogin: preferences.launchAtLogin,
    launchAtLoginAvailable,
  }
}

async function setPreference(request: DesktopPreferenceMutation): Promise<DesktopPreferences> {
  if (request.key === 'globalShortcut') {
    if (request.value !== null && (request.value.trim() === '' || request.value.length > 64)) {
      throw new TypeError('desktop preferences: invalid global shortcut')
    }
    preferences.globalShortcut = request.value === null ? null : request.value.trim()
    applyGlobalShortcut()
  } else {
    if (!launchAtLoginAvailable) throw new Error('desktop preferences: launch at login requires the installed build')
    preferences.launchAtLogin = request.value
    app.setLoginItemSettings({ openAtLogin: request.value })
  }
  await writeDesktopPreferences(preferencesPath(), preferences)
  return preferenceSnapshot()
}

function broadcastHostFailure(message: string): void {
  hostReady = false
  hostError = message
  console.error(message)
  for (const record of windowsByWebContents.values()) {
    if (!record.window.isDestroyed()) record.window.webContents.send(channels.hostFailure, message)
  }
}

const host = new DesktopHostProcess(broadcastHostFailure)

async function startOwnedHost(): Promise<void> {
  hostError = undefined
  await host.start()
  hostReady = true
}

async function stopOwnedHost(): Promise<void> {
  hostReady = false
  await host.stop()
}

function reloadWindows(): void {
  for (const record of windowsByWebContents.values()) {
    if (!record.window.isDestroyed()) record.window.webContents.reload()
  }
}

const pluginManager = new DesktopPluginManager({
  stopHost: stopOwnedHost,
  startHost: startOwnedHost,
  reloadWindows: () => { setTimeout(reloadWindows, 0) },
  parentWindow: () => mainWindow?.window,
})

const updater = new DesktopUpdater(createDefaultUpdaterRuntime(() => mainWindow?.window))
updater.subscribe((state) => {
  const main = mainWindow?.window
  if (main !== undefined && !main.isDestroyed()) main.webContents.send(channels.updateState, state)
})

async function restartHost(): Promise<void> {
  hostReady = false
  hostError = undefined
  await host.restart()
  hostReady = true
  setTimeout(reloadWindows, 0)
}

async function quitDesktop(): Promise<void> {
  if (quitting) return
  quitting = true
  const main = mainWindow?.window
  if (main !== undefined && !main.isDestroyed() && !main.isMinimized() && !main.isMaximized()) {
    await writeWindowBounds(boundsPath(), main.getBounds()).catch((error: unknown) => { console.error(error) })
  }
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = undefined
  for (const record of [...windowsByWebContents.values()]) {
    if (!record.window.isDestroyed()) record.window.destroy()
  }
  await host.stop().catch((error: unknown) => { console.error(error) })
  app.exit(0)
}

function installIpcHandlers(): void {
  ipcMain.handle(channels.bootstrap, (event): DesktopWindowBootstrap => {
    const record = recordForSender(event)
    return {
      windowId: record.id,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      installed: app.isPackaged,
      version: app.getVersion(),
      ...(hostError === undefined ? {} : { hostError }),
    }
  })
  ipcMain.on(channels.intentReady, (event) => {
    const record = recordForSender(event)
    record.intentReady = true
    const intent = record.pendingIntent
    record.pendingIntent = undefined
    if (intent !== undefined) record.window.webContents.send(channels.intent, intent)
  })
  ipcMain.handle(channels.newTask, (event) => {
    recordForSender(event)
    focusMainWithNewTask()
  })
  ipcMain.handle(channels.restartHost, async (event) => {
    recordForSender(event)
    await restartHost()
  })
  ipcMain.handle(channels.pluginList, async (event) => {
    recordForSender(event)
    return await pluginManager.list()
  })
  ipcMain.handle(channels.pluginStage, async (event, request: unknown) => {
    recordForSender(event)
    return await pluginManager.stage(parseDesktopPluginRequest(request))
  })
  ipcMain.handle(channels.pluginApply, async (event, token: unknown) => {
    recordForSender(event)
    if (typeof token !== 'string' || token.length > 128) {
      throw new TypeError('desktop plugins: invalid apply request')
    }
    await pluginManager.apply(token)
  })
  ipcMain.handle(channels.pluginCancel, async (event, token: unknown) => {
    recordForSender(event)
    if (typeof token !== 'string' || token.length > 128) {
      throw new TypeError('desktop plugins: invalid cancel request')
    }
    await pluginManager.cancel(token)
  })
  ipcMain.handle(channels.preferencesGet, (event) => {
    recordForSender(event)
    return preferenceSnapshot()
  })
  ipcMain.handle(channels.preferencesSet, async (event, request: unknown) => {
    recordForSender(event)
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('desktop preferences: invalid request')
    }
    const mutation = request as Record<string, unknown>
    const key = mutation.key
    const value = mutation.value
    if (key === 'globalShortcut' && (value === null || typeof value === 'string')) {
      return await setPreference({ key, value })
    }
    if (key === 'launchAtLogin' && typeof value === 'boolean') {
      return await setPreference({ key, value })
    }
    throw new TypeError('desktop preferences: invalid mutation')
  })
  ipcMain.handle(channels.updateGet, (event) => {
    recordForSender(event)
    return updater.snapshot()
  })
  ipcMain.handle(channels.updateCheck, async (event) => {
    recordForSender(event)
    return await updater.check()
  })
  ipcMain.handle(channels.updateDownload, async (event) => {
    recordForSender(event)
    return await updater.download()
  })
  ipcMain.handle(channels.updateInstall, async (event) => {
    recordForSender(event)
    return await updater.install()
  })
  ipcMain.handle(channels.updateCancel, (event) => {
    recordForSender(event)
    updater.cancel()
    return updater.snapshot()
  })
  ipcMain.handle(channels.updateOpenReleases, (event) => {
    recordForSender(event)
    updater.openReleases()
  })
  ipcMain.on(channels.reportSelection, (event, sessionId: unknown) => {
    const record = recordForSender(event)
    record.sessionId = sessionId === undefined ? undefined : validSessionId(sessionId) ? sessionId : record.sessionId
  })
  ipcMain.on(channels.notify, (event, value: unknown) => {
    recordForSender(event)
    if (typeof value !== 'object' || value === null) return
    const payload = value as Record<string, unknown>
    const sessionId = payload.sessionId
    const title = payload.title
    if (!validSessionId(sessionId) || typeof title !== 'string' || title.length > 512) return
    const visible = [...windowsByWebContents.values()].some(record =>
      record.sessionId === sessionId && record.window.isFocused())
    if (visible || !Notification.isSupported()) return
    const notification = new Notification({ title: title || PRODUCT_NAME, body: copy().completed, icon: icon() })
    notification.on('click', () => { focusMain({ type: 'open-session', sessionId: sessionId as SessionId }) })
    notification.show()
  })
}

async function main(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', (_event, argv) => { routeSecondInstance(argv) })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    routeSecondInstance([url])
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    void quitDesktop()
  })
  await app.whenReady()
  preferences = await readDesktopPreferences(preferencesPath())
  launchAtLoginAvailable = process.platform !== 'linux' && app.isPackaged && app.isDefaultProtocolClient('dsh')
  if (launchAtLoginAvailable) {
    app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin })
  }
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  installIpcHandlers()
  try {
    await startOwnedHost()
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error)
    console.error(hostError)
  }
  await createMainWindow()
  createTray()
  applyGlobalShortcut()
  const initialLink = pendingSecondInstance === undefined
    ? deepLinkFromArgv(process.argv)
    : pendingSecondInstance ?? undefined
  pendingSecondInstance = undefined
  routeDeepLink(initialLink)
  app.on('activate', () => { mainWindow?.window.show(); mainWindow?.window.focus() })
}

void main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
