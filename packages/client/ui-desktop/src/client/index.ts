/** Desktop-only Client plugin: title bar, window intents, and completion notifications. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DesktopTitleBar, type DesktopTitleBarInjected } from './TitleBar.tsx'
import { DesktopBrandMark, DesktopBrandName } from './DesktopBrand.tsx'
import {
  DesktopPreferences,
  type DesktopPreferencesInjected,
  type DesktopPreferencesValue,
} from './DesktopPreferences.tsx'
import {
  PluginManager,
  type DesktopPluginInfo,
  type DesktopPluginStage,
  type PluginManagerInjected,
} from './PluginManager.tsx'
import { en, zh, type DesktopKey } from './locales.ts'

interface DesktopApi {
  openSession(sessionId: string): Promise<void>
  openMain(): Promise<void>
  newTask(): Promise<void>
  reportSelection(sessionId: string | undefined): void
  notifyTaskSettled(sessionId: string, title: string): void
  listPlugins(): Promise<readonly DesktopPluginInfo[]>
  stagePlugin(request: Parameters<PluginManagerInjected['stage']>[0]): Promise<DesktopPluginStage>
  applyPlugin(token: string): Promise<void>
  cancelPlugin(token: string): Promise<void>
  getPreferences(): Promise<DesktopPreferencesValue>
  setPreference(request: Parameters<DesktopPreferencesInjected['write']>[0]): Promise<DesktopPreferencesValue>
  onIntent(listener: (intent: { readonly type: 'new-task' }) => void): () => void
}

interface DesktopGlobal {
  dshDesktop?: DesktopApi
  __DSH_DESKTOP__?: { readonly kind?: unknown }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop window controls and title-bar labels. */
    desktop: DesktopKey
  }
}

const NS = 'desktop'

/** Required Desktop client services. */
export const inject = ['locale', 'sessions', 'slots']

function completionTransitions(previous: SessionListState, current: SessionListState): SessionId[] {
  return current.ids.filter((sessionId) => {
    const before = previous.byId[sessionId]
    const after = current.byId[sessionId]
    return before?.running === true && after?.running === false && ! after.blank
  })
}

/** Install the Desktop title bar and bridge shell intents into Client state. */
export function apply(ctx: Context): void {
  const globals = globalThis as DesktopGlobal
  const desktop = globals.dshDesktop
  const kind = globals.__DSH_DESKTOP__?.kind
  if (desktop === undefined || (kind !== 'main' && kind !== 'task')) {
    throw new Error('ui-desktop: the Electron preload bootstrap is unavailable')
  }
  const sessions = ctx.get('sessions') as ISessions
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): DesktopTitleBarInjected => ({
    kind,
    openMain: () => { void desktop.openMain() },
    openSession: (sessionId) => { void desktop.openSession(sessionId) },
    newTask: () => { void desktop.newTask() },
  })
  ctx.slots.inject('shell.titlebar', () => ctx.slots.register({
    name: 'shell.titlebar',
    locale: NS,
    inject: injected,
  }, DesktopTitleBar))
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', locale: NS }, DesktopBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, DesktopBrandName)
    }))
  if (kind === 'main') {
    const preferences = (): DesktopPreferencesInjected => ({
      read: () => desktop.getPreferences(),
      write: request => desktop.setPreference(request),
    })
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'desktop-integration',
      order: 40,
      locale: NS,
      inject: preferences,
    }, DesktopPreferences))
    const pluginManager = (): PluginManagerInjected => ({
      list: () => desktop.listPlugins(),
      stage: request => desktop.stagePlugin(request),
      apply: token => desktop.applyPlugin(token),
      cancel: token => desktop.cancelPlugin(token),
    })
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'desktop-manage',
      order: 20,
      label: () => t('plugins.tab'),
      locale: NS,
      inject: pluginManager,
    }, PluginManager))
  }

  let previous = sessions.list.getSnapshot()
  desktop.reportSelection(previous.current)
  ctx.effect(() => {
    const stopList = sessions.list.subscribe(() => {
      const current = sessions.list.getSnapshot()
      desktop.reportSelection(current.current)
      if (kind === 'main') {
        for (const sessionId of completionTransitions(previous, current)) {
          desktop.notifyTaskSettled(sessionId, current.byId[sessionId]?.displayTitle ?? sessionId)
        }
      }
      previous = current
    })
    const stopIntent = desktop.onIntent(() => {
      if (kind === 'main') sessions.clear()
    })
    return () => { stopIntent(); stopList() }
  }, 'ui-desktop: window state bridge')
}
