/** One MessagePort server carrying a Renderer to the in-process Host services. */
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type { ClientBootRegistry, ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import {
  DESKTOP_TRANSPORT_VERSION,
  type DesktopClientFrame,
  type DesktopHostFrame,
  type DesktopRequestId,
} from './protocol.ts'

/** Electron Utility Process MessagePort subset used by the transport. */
export interface DesktopHostPort {
  postMessage(message: DesktopHostFrame): void
  start(): void
  close(): void
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): this
  on(event: 'close', listener: () => void): this
  off(event: 'message', listener: (event: { readonly data: unknown }) => void): this
  off(event: 'close', listener: () => void): this
}

interface StreamRecord {
  readonly controller: AbortController
  readonly iterator: AsyncIterator<unknown>
  pulling: boolean
}

/** Dependencies captured after the desktop Host reaches Loader readiness. */
export interface DesktopPortServices {
  readonly boot: ClientBootRegistry
  readonly modules: ClientModuleRegistry
  readonly fetch: ConnectionFetchHandler
  readonly gateway: TypertGateway
  readonly maxBodyBytes: number
}

function transferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function requestId(value: unknown): DesktopRequestId | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value as DesktopRequestId
    : undefined
}

/**
 * Parse one untrusted Renderer frame without accepting extra fields.
 * @param value - candidate frame received through a window MessagePort.
 * @returns the validated Desktop client frame.
 */
export function parseDesktopClientFrame(value: unknown): DesktopClientFrame {
  if (!isRecord(value) || value.v !== DESKTOP_TRANSPORT_VERSION || typeof value.t !== 'string') {
    throw new TypeError('desktop transport: invalid frame header')
  }
  const id = requestId(value.id)
  if (id === undefined) throw new TypeError('desktop transport: invalid request id')
  switch (value.t) {
    case 'boot':
    case 'stream-pull':
    case 'abort':
      if (!exactKeys(value, ['v', 't', 'id'])) throw new TypeError(`desktop transport: invalid ${value.t} frame`)
      return value as DesktopClientFrame
    case 'bundle':
      if (!exactKeys(value, ['v', 't', 'id', 'url']) || typeof value.url !== 'string') {
        throw new TypeError('desktop transport: invalid bundle frame')
      }
      return value as DesktopClientFrame
    case 'stream-open':
      if (!exactKeys(value, ['v', 't', 'id', 'endpoint', 'payload']) || typeof value.endpoint !== 'string') {
        throw new TypeError('desktop transport: invalid stream-open frame')
      }
      return value as DesktopClientFrame
    case 'fetch': {
      const keys = value.body === undefined
        ? ['v', 't', 'id', 'url', 'method', 'headers']
        : ['v', 't', 'id', 'url', 'method', 'headers', 'body']
      if (!exactKeys(value, keys)
        || typeof value.url !== 'string'
        || typeof value.method !== 'string'
        || !Array.isArray(value.headers)
        || value.headers.some(header => !Array.isArray(header)
          || header.length !== 2
          || typeof header[0] !== 'string'
          || typeof header[1] !== 'string')
        || (value.body !== undefined && !(value.body instanceof ArrayBuffer))) {
        throw new TypeError('desktop transport: invalid fetch frame')
      }
      return value as DesktopClientFrame
    }
    default:
      throw new TypeError(`desktop transport: unknown frame type ${JSON.stringify(value.t)}`)
  }
}

/** Own one Renderer port until it closes or the Host disposes. */
export class DesktopPortServer {
  private readonly streams = new Map<DesktopRequestId, StreamRecord>()
  private readonly openingStreams = new Map<DesktopRequestId, AbortController>()
  private readonly fetches = new Map<DesktopRequestId, AbortController>()
  private readonly operations = new Set<Promise<void>>()
  private closed = false

  /**
   * @param port - transferred Renderer channel.
   * @param services - ready Host capabilities.
   */
  constructor(
    private readonly port: DesktopHostPort,
    private readonly services: DesktopPortServices,
    private readonly onDisposed: () => void = () => {},
  ) {
    port.on('message', this.onMessage)
    port.on('close', this.onClose)
    port.start()
  }

  /** Close the port and await every open stream's iterator disposal. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.port.off('message', this.onMessage)
    this.port.off('close', this.onClose)
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const stream of streams) stream.controller.abort(new Error('desktop transport disposed'))
    for (const controller of this.openingStreams.values()) controller.abort(new Error('desktop transport disposed'))
    for (const controller of this.fetches.values()) controller.abort(new Error('desktop transport disposed'))
    this.openingStreams.clear()
    this.fetches.clear()
    await Promise.allSettled([
      ...streams.map(stream => stream.iterator.return?.()),
      ...this.operations,
    ])
    this.port.close()
    this.onDisposed()
  }

  private readonly onMessage = (event: { readonly data: unknown }): void => {
    if (this.closed) return
    let frame: DesktopClientFrame
    try {
      frame = parseDesktopClientFrame(event.data)
    } catch (reason) {
      const rawId = isRecord(event.data) ? requestId(event.data.id) : undefined
      if (rawId !== undefined) this.send({ v: 1, t: 'fault', id: rawId, message: errorMessage(reason) })
      return
    }
    const operation = this.dispatch(frame).catch((reason: unknown) => {
      this.send({ v: 1, t: 'fault', id: frame.id, message: errorMessage(reason) })
    })
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) })
  }

  private readonly onClose = (): void => {
    void this.dispose()
  }

  private send(frame: DesktopHostFrame): void {
    // Electron MessagePortMain clones ArrayBuffers; its transfer list accepts
    // MessagePorts only.
    if (!this.closed) this.port.postMessage(frame)
  }

  private async dispatch(frame: DesktopClientFrame): Promise<void> {
    switch (frame.t) {
      case 'boot':
        this.send({ v: 1, t: 'boot-result', id: frame.id, injections: this.services.boot.collect() })
        return
      case 'fetch':
        await this.fetch(frame)
        return
      case 'bundle':
        this.bundle(frame.id, frame.url)
        return
      case 'stream-open':
        await this.openStream(frame.id, frame.endpoint, frame.payload)
        return
      case 'stream-pull':
        await this.pullStream(frame.id)
        return
      case 'abort':
        await this.abort(frame.id)
        return
      default:
        frame satisfies never
    }
  }

  private async fetch(frame: Extract<DesktopClientFrame, { t: 'fetch' }>): Promise<void> {
    if (this.fetches.has(frame.id)) throw new Error(`desktop transport: duplicate fetch ${frame.id}`)
    const bodyLength = frame.body?.byteLength ?? 0
    if (bodyLength > this.services.maxBodyBytes) {
      throw new Error(`desktop transport: request body exceeds ${String(this.services.maxBodyBytes)} bytes`)
    }
    const url = new URL(frame.url)
    if (url.origin !== 'http://dsh.internal' || !url.pathname.startsWith('/api/')) {
      throw new Error(`desktop transport: invalid API URL ${JSON.stringify(frame.url)}`)
    }
    const controller = new AbortController()
    this.fetches.set(frame.id, controller)
    const request = new Request(url, {
      method: frame.method,
      headers: new Headers([...frame.headers] as [string, string][]),
      ...(frame.body === undefined ? {} : { body: frame.body }),
      signal: controller.signal,
    })
    try {
      const response = await this.services.fetch.fetch(request)
      const bytes = await response.arrayBuffer()
      const result: DesktopHostFrame = {
        v: 1,
        t: 'fetch-result',
        id: frame.id,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: bytes,
      }
      this.send(result)
    } finally {
      this.fetches.delete(frame.id)
    }
  }

  private bundle(id: DesktopRequestId, url: string): void {
    const parsed = new URL(url, 'http://dsh.internal')
    if (parsed.origin !== 'http://dsh.internal' || !parsed.pathname.startsWith('/plugins/')) {
      throw new Error(`desktop transport: invalid bundle URL ${JSON.stringify(url)}`)
    }
    const artifact = this.services.modules.artifact(`${parsed.pathname}${parsed.search}`)
    if (artifact === undefined) throw new Error(`desktop transport: unknown bundle ${JSON.stringify(url)}`)
    const body = transferable(artifact.body)
    this.send({ v: 1, t: 'bundle-result', id, contentType: artifact.contentType, body })
  }

  private async openStream(id: DesktopRequestId, endpoint: string, payload: unknown): Promise<void> {
    if (this.streams.has(id) || this.openingStreams.has(id)) {
      throw new Error(`desktop transport: duplicate stream ${id}`)
    }
    const controller = new AbortController()
    this.openingStreams.set(id, controller)
    try {
      const source = await this.services.gateway.wireStream.open(endpoint, payload, controller.signal)
      const iterator = source[Symbol.asyncIterator]()
      if (controller.signal.aborted) {
        await iterator.return?.()
        return
      }
      this.streams.set(id, { controller, iterator, pulling: false })
      this.send({ v: 1, t: 'stream-ready', id })
    } finally {
      this.openingStreams.delete(id)
    }
  }

  private async pullStream(id: DesktopRequestId): Promise<void> {
    const stream = this.streams.get(id)
    if (stream === undefined) throw new Error(`desktop transport: unknown stream ${id}`)
    if (stream.pulling) throw new Error(`desktop transport: overlapping pull for stream ${id}`)
    stream.pulling = true
    try {
      const next = await stream.iterator.next()
      if (next.done === true) {
        this.streams.delete(id)
        this.send({ v: 1, t: 'stream-end', id })
      } else {
        this.send({ v: 1, t: 'stream-item', id, value: next.value })
      }
    } catch (reason) {
      this.streams.delete(id)
      const failure = this.services.gateway.wireStream.failure(reason)
      this.send({ v: 1, t: 'stream-error', id, failure })
    } finally {
      stream.pulling = false
    }
  }

  private async abort(id: DesktopRequestId): Promise<void> {
    const fetch = this.fetches.get(id)
    if (fetch !== undefined) {
      this.fetches.delete(id)
      fetch.abort(new Error('desktop client aborted request'))
    }
    const opening = this.openingStreams.get(id)
    if (opening !== undefined) {
      this.openingStreams.delete(id)
      opening.abort(new Error('desktop client aborted stream'))
    }
    const stream = this.streams.get(id)
    if (stream === undefined) return
    this.streams.delete(id)
    stream.controller.abort(new Error('desktop client aborted stream'))
    await stream.iterator.return?.()
  }
}
