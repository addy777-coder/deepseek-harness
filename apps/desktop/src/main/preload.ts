/** Context-isolated bridge for fixed desktop shell operations and Host port delivery. */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopIntent, DesktopShellApi, DesktopUpdateState, DesktopWindowBootstrap,
} from '../shared/contracts.ts'
import { channels } from './channels.ts'

ipcRenderer.on(channels.hostPort, (event, payload: { readonly windowId: string }) => {
  const port = event.ports[0]
  if (port === undefined || event.ports.length !== 1) return
  window.postMessage({ source: channels.hostPort, windowId: payload.windowId }, '*', [port])
})

function subscribeIntent(listener: Parameters<DesktopShellApi['onIntent']>[0]): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Reflect.get(value, 'type') === 'new-task') {
      listener({ type: 'new-task' })
    } else if (Reflect.get(value, 'type') === 'open-session' && typeof Reflect.get(value, 'sessionId') === 'string') {
      listener(value as DesktopIntent)
    }
  }
  ipcRenderer.on(channels.intent, wrapped)
  ipcRenderer.send(channels.intentReady)
  return () => { ipcRenderer.off(channels.intent, wrapped) }
}

function subscribeHostFailure(listener: Parameters<DesktopShellApi['onHostFailure']>[0]): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (typeof value === 'string') listener(value)
  }
  ipcRenderer.on(channels.hostFailure, wrapped)
  return () => { ipcRenderer.off(channels.hostFailure, wrapped) }
}

function subscribeUpdateState(listener: Parameters<DesktopShellApi['onUpdateState']>[0]): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'phase') === 'string') {
      listener(value as DesktopUpdateState)
    }
  }
  ipcRenderer.on(channels.updateState, wrapped)
  return () => { ipcRenderer.off(channels.updateState, wrapped) }
}

const api: DesktopShellApi = {
  bootstrap: () => ipcRenderer.invoke(channels.bootstrap) as Promise<DesktopWindowBootstrap>,
  newTask: () => ipcRenderer.invoke(channels.newTask) as Promise<void>,
  reportSelection: (sessionId) => { ipcRenderer.send(channels.reportSelection, sessionId) },
  notifyTaskSettled: (sessionId, title) => { ipcRenderer.send(channels.notify, { sessionId, title }) },
  restartHost: () => ipcRenderer.invoke(channels.restartHost) as Promise<void>,
  listPlugins: () => ipcRenderer.invoke(channels.pluginList) as ReturnType<DesktopShellApi['listPlugins']>,
  stagePlugin: request => ipcRenderer.invoke(channels.pluginStage, request) as ReturnType<DesktopShellApi['stagePlugin']>,
  applyPlugin: token => ipcRenderer.invoke(channels.pluginApply, token) as Promise<void>,
  cancelPlugin: token => ipcRenderer.invoke(channels.pluginCancel, token) as Promise<void>,
  getPreferences: () => ipcRenderer.invoke(channels.preferencesGet) as ReturnType<DesktopShellApi['getPreferences']>,
  setPreference: request => ipcRenderer.invoke(channels.preferencesSet, request) as ReturnType<DesktopShellApi['setPreference']>,
  getUpdateState: () => ipcRenderer.invoke(channels.updateGet) as ReturnType<DesktopShellApi['getUpdateState']>,
  checkForUpdate: () => ipcRenderer.invoke(channels.updateCheck) as ReturnType<DesktopShellApi['checkForUpdate']>,
  downloadUpdate: () => ipcRenderer.invoke(channels.updateDownload) as ReturnType<DesktopShellApi['downloadUpdate']>,
  installUpdate: () => ipcRenderer.invoke(channels.updateInstall) as ReturnType<DesktopShellApi['installUpdate']>,
  cancelUpdate: () => ipcRenderer.invoke(channels.updateCancel) as ReturnType<DesktopShellApi['cancelUpdate']>,
  openReleases: () => ipcRenderer.invoke(channels.updateOpenReleases) as Promise<void>,
  onIntent: listener => subscribeIntent(listener),
  onHostFailure: listener => subscribeHostFailure(listener),
  onUpdateState: listener => subscribeUpdateState(listener),
}

contextBridge.exposeInMainWorld('dshDesktop', api)
