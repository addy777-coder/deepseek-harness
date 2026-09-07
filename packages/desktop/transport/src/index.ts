/** Desktop GUI Host adapter for Electron Utility Process MessagePorts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import { DesktopPortServer, type DesktopHostPort } from './server.ts'
import {
  DESKTOP_TRANSPORT_VERSION,
  type DesktopHostControlFrame,
  type DesktopHostLifecycleFrame,
  type DesktopWindowId,
} from './protocol.ts'

export {
  DESKTOP_TRANSPORT_VERSION,
  type DesktopClientFrame,
  type DesktopHostControlFrame,
  type DesktopHostFrame,
  type DesktopHostLifecycleFrame,
  type DesktopHostStartupPhase,
  type DesktopRequestId,
  type DesktopWindowId,
  parseDesktopHostLifecycleFrame,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-transport'

/** Host services exposed through each attached Renderer port. */
export const inject = ['clientBoot', 'clientModules', 'connection', 'typertGateway']

const DEFAULT_MAX_BODY_BYTES = 300 * 1024 * 1024

/** Desktop transport configuration. */
export interface Config {
  /** Maximum complete Renderer request body. Default: 300 MiB. */
  maxBodyBytes?: number
}

export const Config: z<Config> = z.object({
  maxBodyBytes: z.natural().min(1).default(DEFAULT_MAX_BODY_BYTES),
})

interface ParentPort {
  postMessage(message: DesktopHostLifecycleFrame): void
  on(event: 'message', listener: (event: { readonly data: unknown; readonly ports: readonly DesktopHostPort[] }) => void): this
  off(event: 'message', listener: (event: { readonly data: unknown; readonly ports: readonly DesktopHostPort[] }) => void): this
}

function resolveParentPort(): ParentPort {
  const port = (process as unknown as { readonly parentPort?: ParentPort }).parentPort
  if (port === undefined) {
    throw new Error('desktop transport: dsh --profile desktop must run in an Electron Utility Process')
  }
  return port
}

/**
 * Parse one untrusted main-process control frame without accepting extra fields.
 * @param value - candidate control frame received through the Utility Process parent port.
 * @returns the validated attach or shutdown frame.
 */
export function parseDesktopHostControlFrame(value: unknown): DesktopHostControlFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('desktop transport: invalid control frame')
  }
  const record = value as Record<string, unknown>
  if (record.v !== DESKTOP_TRANSPORT_VERSION || (record.t !== 'attach' && record.t !== 'shutdown')) {
    throw new TypeError('desktop transport: invalid control frame')
  }
  if (record.t === 'shutdown') {
    if (Object.keys(record).length !== 2) throw new TypeError('desktop transport: invalid shutdown frame')
    return { v: 1, t: 'shutdown' }
  }
  if (Object.keys(record).length !== 3 || typeof record.windowId !== 'string'
    || record.windowId.length === 0 || record.windowId.length > 128) {
    throw new TypeError('desktop transport: invalid attach frame')
  }
  return { v: 1, t: 'attach', windowId: record.windowId as DesktopWindowId }
}

/**
 * Attach the ready DSH Host to Electron-transferred Renderer ports.
 * @param ctx - desktop profile context.
 * @param config - resolved request bound.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const parent = resolveParentPort()
  parent.postMessage({ v: 1, t: 'startup', phase: 'loader' })
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const servers = new Set<DesktopPortServer>()
  const pending: DesktopHostPort[] = []
  let ready = false
  let stopping = false

  const attach = (port: DesktopHostPort): void => {
    if (stopping) {
      port.close()
      return
    }
    if (!ready) {
      pending.push(port)
      return
    }
    const server = new DesktopPortServer(port, {
      boot: ctx.clientBoot,
      modules: ctx.clientModules,
      fetch: ctx.connection.createSharedFetchHandler('/api'),
      gateway: ctx.typertGateway,
      maxBodyBytes,
    }, () => { servers.delete(server) })
    servers.add(server)
  }

  const onMessage = (event: { readonly data: unknown; readonly ports: readonly DesktopHostPort[] }): void => {
    let frame: DesktopHostControlFrame
    try {
      frame = parseDesktopHostControlFrame(event.data)
    } catch (error) {
      ctx.logger.warn(error)
      return
    }
    if (frame.t === 'attach') {
      const port = event.ports[0]
      if (port === undefined || event.ports.length !== 1) {
        ctx.logger.warn('desktop transport: attach requires exactly one MessagePort')
        return
      }
      attach(port)
      return
    }
    if (event.ports.length !== 0) {
      for (const port of event.ports) port.close()
      ctx.logger.warn('desktop transport: shutdown does not accept MessagePorts')
      return
    }
    if (stopping) return
    stopping = true
    void Promise.allSettled([...servers].map(server => server.dispose()))
      .then(() => ctx.root.fiber.dispose())
      .then(() => {
        parent.postMessage({ v: 1, t: 'stopped' })
        process.exit(0)
      })
      .catch((error: unknown) => { ctx.logger.error(error) })
  }

  parent.on('message', onMessage)
  ctx.effect(() => async () => {
    parent.off('message', onMessage)
    for (const port of pending.splice(0)) port.close()
    await Promise.allSettled([...servers].map(server => server.dispose()))
    servers.clear()
  }, 'desktop transport: parent and Renderer ports')

  const settled = ctx.get('loader')?.await()
  const announce = (): void => {
    if (stopping || ctx.get('connection') === undefined || ctx.get('clientModules') === undefined) return
    ready = true
    for (const port of pending.splice(0)) attach(port)
    parent.postMessage({ v: 1, t: 'ready' })
  }
  if (settled === undefined) announce()
  else void settled.then(announce, () => {})
}
