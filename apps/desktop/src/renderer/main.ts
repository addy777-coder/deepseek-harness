/** Desktop Renderer entry: acquire Host transport, apply boot rows, and run the shared GUI shell. */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { DesktopWindowBootstrap } from '../shared/contracts.ts'
import { DesktopTransportClient } from './transport.ts'
import './desktop.css'

interface TransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

const copy = {
  en: {
    title: 'DSH Desktop could not start',
    retry: 'Restart Host',
  },
  zh: {
    title: 'DSH Desktop 启动失败',
    retry: '重启 Host',
  },
} as const

function labels(): { readonly title: string; readonly retry: string } {
  return navigator.language.toLowerCase().startsWith('zh') ? copy.zh : copy.en
}

function waitForHostPort(windowId: string): Promise<MessagePort> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>): void => {
      const value = event.data
      const port = event.ports[0]
      if (typeof value !== 'object' || value === null
        || Reflect.get(value, 'source') !== 'dsh-desktop/host-port'
        || Reflect.get(value, 'windowId') !== windowId
        || port === undefined || event.ports.length !== 1) return
      window.removeEventListener('message', listener)
      resolve(port)
    }
    window.addEventListener('message', listener)
  })
}

async function applyInjections(
  rows: readonly IndexInjection[],
  loadBundle: (url: string) => Promise<void>,
): Promise<void> {
  for (const row of rows) {
    switch (row.kind) {
      case 'global':
        Reflect.set(globalThis, row.name, row.value)
        break
      case 'script': {
        const script = document.createElement('script')
        script.textContent = row.text
        ;(row.placement === 'head' ? document.head : document.body).append(script)
        break
      }
      case 'script-src':
        await loadBundle(row.src)
        break
      case 'script-preload':
        break
      case 'style': {
        const style = document.createElement('style')
        style.textContent = row.text
        document.head.append(style)
        break
      }
      case 'html':
        ;(row.placement === 'head' ? document.head : document.body)
          .insertAdjacentHTML('beforeend', row.html)
        break
      default:
        row satisfies never
    }
  }
}

function renderFailure(reason: unknown): void {
  const root = document.getElementById('root')
  if (root === null) return
  const text = labels()
  root.replaceChildren()
  const card = document.createElement('main')
  card.className = 'desktop-failure'
  const title = document.createElement('h1')
  title.textContent = text.title
  const detail = document.createElement('pre')
  detail.textContent = reason instanceof Error ? reason.message : String(reason)
  const button = document.createElement('button')
  button.textContent = text.retry
  button.addEventListener('click', () => {
    button.disabled = true
    void window.dshDesktop.restartHost().catch((error: unknown) => {
      detail.textContent = error instanceof Error ? error.message : String(error)
      button.disabled = false
    })
  })
  card.append(title, detail, button)
  root.append(card)
}

async function run(): Promise<void> {
  const bootstrap: DesktopWindowBootstrap = await window.dshDesktop.bootstrap()
  if (bootstrap.hostError !== undefined) throw new Error(bootstrap.hostError)
  window.__DSH_DESKTOP__ = bootstrap
  document.body.dataset.dshDesktop = 'main'
  const port = await waitForHostPort(bootstrap.windowId)
  const transport = new DesktopTransportClient(port)
  ;(globalThis as TransportGlobal).__DSH_TRANSPORT__ = {
    fetch: transport.fetch,
    openStream: transport.openStream,
    loadBundle: url => transport.loadBundle(url),
    ownsHost: true,
  }
  await applyInjections(await transport.boot(), url => transport.loadBundle(url))
  const root = document.getElementById('root')
  if (root === null) throw new Error('desktop renderer: missing #root')
  const app = new AppWebEntry(root)
  window.addEventListener('beforeunload', () => {
    void app.dispose()
    transport.close()
  }, { once: true })
  window.dshDesktop.onHostFailure((message) => { renderFailure(new Error(message)) })
  await app.run()
}

void run().catch(renderFailure)
