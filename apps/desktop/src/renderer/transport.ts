/** Renderer client for the pull-driven desktop MessagePort protocol. */
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const DESKTOP_TRANSPORT_VERSION = 1 as const
type DesktopRequestId = string & { readonly __desktopRequestId: unique symbol }
type DesktopClientFrame =
  | { readonly v: 1; readonly t: 'boot'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'fetch'; readonly id: DesktopRequestId; readonly url: string; readonly method: string; readonly headers: readonly (readonly [string, string])[]; readonly body?: ArrayBuffer }
  | { readonly v: 1; readonly t: 'bundle'; readonly id: DesktopRequestId; readonly url: string }
  | { readonly v: 1; readonly t: 'stream-open'; readonly id: DesktopRequestId; readonly endpoint: string; readonly payload: unknown }
  | { readonly v: 1; readonly t: 'stream-pull'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'abort'; readonly id: DesktopRequestId }
type DesktopHostFrame =
  | { readonly v: 1; readonly t: 'boot-result'; readonly id: DesktopRequestId; readonly injections: readonly unknown[] }
  | { readonly v: 1; readonly t: 'fetch-result'; readonly id: DesktopRequestId; readonly status: number; readonly statusText: string; readonly headers: readonly (readonly [string, string])[]; readonly body: ArrayBuffer }
  | { readonly v: 1; readonly t: 'bundle-result'; readonly id: DesktopRequestId; readonly contentType: string; readonly body: ArrayBuffer }
  | { readonly v: 1; readonly t: 'stream-ready'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'stream-item'; readonly id: DesktopRequestId; readonly value: unknown }
  | { readonly v: 1; readonly t: 'stream-end'; readonly id: DesktopRequestId }
  | { readonly v: 1; readonly t: 'stream-error'; readonly id: DesktopRequestId; readonly failure: { readonly code: string; readonly message: string; readonly details: object } }
  | { readonly v: 1; readonly t: 'fault'; readonly id: DesktopRequestId; readonly message: string }
type RpcStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

interface PendingRequest {
  resolve(frame: DesktopHostFrame): void
  reject(reason: unknown): void
}

interface StreamState {
  readonly ready: Promise<void>
  resolveReady(): void
  rejectReady(reason: unknown): void
  cleanup(): void
  next: PendingRequest | undefined
  closed: boolean
}

function id(): DesktopRequestId {
  return randomUUID() as DesktopRequestId
}

function rejectionError(reason: unknown, message: string): Error {
  return reason instanceof Error
    ? reason
    : new Error(message, reason === undefined ? undefined : { cause: reason })
}

function errorOf(frame: Extract<DesktopHostFrame, { t: 'fault' | 'stream-error' }>): Error {
  const error = new Error(frame.t === 'fault' ? frame.message : frame.failure.message)
  if (frame.t === 'stream-error') Object.assign(error, frame.failure)
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validId(value: unknown): value is DesktopRequestId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function validHeaders(value: unknown): value is readonly (readonly [string, string])[] {
  return Array.isArray(value) && value.every(header => Array.isArray(header)
    && header.length === 2
    && typeof header[0] === 'string'
    && typeof header[1] === 'string')
}

/** Parse one untrusted Host frame without accepting extra or mistyped fields. */
export function parseDesktopHostFrame(value: unknown): DesktopHostFrame {
  if (!isRecord(value) || value.v !== DESKTOP_TRANSPORT_VERSION
    || typeof value.t !== 'string' || !validId(value.id)) {
    throw new TypeError('desktop transport: invalid Host frame header')
  }
  switch (value.t) {
    case 'boot-result':
      if (!exactKeys(value, ['v', 't', 'id', 'injections']) || !Array.isArray(value.injections)) {
        throw new TypeError('desktop transport: invalid boot-result frame')
      }
      break
    case 'fetch-result':
      if (!exactKeys(value, ['v', 't', 'id', 'status', 'statusText', 'headers', 'body'])
        || !Number.isInteger(value.status)
        || (value.status as number) < 200
        || (value.status as number) > 599
        || typeof value.statusText !== 'string'
        || !validHeaders(value.headers)
        || !(value.body instanceof ArrayBuffer)) {
        throw new TypeError('desktop transport: invalid fetch-result frame')
      }
      break
    case 'bundle-result':
      if (!exactKeys(value, ['v', 't', 'id', 'contentType', 'body'])
        || typeof value.contentType !== 'string'
        || !(value.body instanceof ArrayBuffer)) {
        throw new TypeError('desktop transport: invalid bundle-result frame')
      }
      break
    case 'stream-ready':
    case 'stream-end':
      if (!exactKeys(value, ['v', 't', 'id'])) {
        throw new TypeError(`desktop transport: invalid ${value.t} frame`)
      }
      break
    case 'stream-item':
      if (!exactKeys(value, ['v', 't', 'id', 'value'])) {
        throw new TypeError('desktop transport: invalid stream-item frame')
      }
      break
    case 'stream-error': {
      const failure = value.failure
      if (!exactKeys(value, ['v', 't', 'id', 'failure']) || !isRecord(failure)
        || !exactKeys(failure, ['code', 'message', 'details'])
        || typeof failure.code !== 'string'
        || typeof failure.message !== 'string'
        || !isRecord(failure.details)) {
        throw new TypeError('desktop transport: invalid stream-error frame')
      }
      break
    }
    case 'fault':
      if (!exactKeys(value, ['v', 't', 'id', 'message']) || typeof value.message !== 'string') {
        throw new TypeError('desktop transport: invalid fault frame')
      }
      break
    default:
      throw new TypeError(`desktop transport: unknown Host frame type ${JSON.stringify(value.t)}`)
  }
  return value as unknown as DesktopHostFrame
}

/** One Renderer connection over a transferred MessagePort. */
export class DesktopTransportClient {
  private readonly pending = new Map<DesktopRequestId, PendingRequest>()
  private readonly streams = new Map<DesktopRequestId, StreamState>()
  private closed = false

  /** @param port - dedicated port paired directly with the Host Utility Process. */
  constructor(private readonly port: MessagePort) {
    port.addEventListener('message', this.onMessage)
    port.addEventListener('messageerror', this.onMessageError)
    port.addEventListener('close', this.onClose)
    port.start()
  }

  /** Fetch-compatible unary carrier consumed by Client Connection. */
  readonly fetch: RpcFetch = async (input, init) => {
    const request = new Request(input, init)
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()
    const requestId = id()
    // Electron's peer is MessagePortMain. Its transfer list accepts ports,
    // not ArrayBuffers, so request bytes use structured cloning too.
    const response = await this.once(requestId, {
      v: 1,
      t: 'fetch',
      id: requestId,
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      ...(body === undefined ? {} : { body }),
    }, request.signal)
    if (response.t !== 'fetch-result') throw new Error(`desktop transport: expected fetch-result, got ${response.t}`)
    const responseBody = response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : response.body
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers] as [string, string][],
    })
  }

  /** Pull-driven Gateway stream carrier consumed by Client Connection. */
  readonly openStream: RpcStreamOpen = (endpoint: string, payload: unknown, signal: AbortSignal) => {
    const streamId = id()
    let resolveReady!: () => void
    let rejectReady!: (reason: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => {})
    const abort = (): void => {
      this.post({ v: 1, t: 'abort', id: streamId })
      this.finishStream(streamId, rejectionError(signal.reason, 'desktop stream aborted'))
    }
    const state: StreamState = {
      ready,
      resolveReady,
      rejectReady,
      cleanup: () => { signal.removeEventListener('abort', abort) },
      next: undefined,
      closed: false,
    }
    this.streams.set(streamId, state)
    this.post({ v: 1, t: 'stream-open', id: streamId, endpoint, payload })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })

    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        await ready
        if (state.closed) return { done: true, value: undefined }
        if (state.next !== undefined) throw new Error('desktop transport: overlapping client stream pull')
        const next = new Promise<IteratorResult<unknown>>((resolve, reject) => {
          state.next = {
            resolve: (frame) => {
              state.next = undefined
              if (frame.t === 'stream-item') resolve({ done: false, value: frame.value })
              else if (frame.t === 'stream-end') resolve({ done: true, value: undefined })
              else reject(new Error(`desktop transport: expected stream result, got ${frame.t}`))
            },
            reject,
          }
        })
        this.post({ v: 1, t: 'stream-pull', id: streamId })
        return await next
      },
      return: () => {
        this.post({ v: 1, t: 'abort', id: streamId })
        this.finishStream(streamId)
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }

  /** Receive the current Host-authored startup injection table. */
  async boot(): Promise<readonly IndexInjection[]> {
    const requestId = id()
    const response = await this.once(requestId, { v: 1, t: 'boot', id: requestId })
    if (response.t !== 'boot-result') throw new Error(`desktop transport: expected boot-result, got ${response.t}`)
    return response.injections as readonly IndexInjection[]
  }

  /** Fetch and execute one graph-advertised client bundle. */
  async loadBundle(url: string): Promise<void> {
    const requestId = id()
    const response = await this.once(requestId, { v: 1, t: 'bundle', id: requestId, url })
    if (response.t !== 'bundle-result') throw new Error(`desktop transport: expected bundle-result, got ${response.t}`)
    if (!response.contentType.toLowerCase().startsWith('text/javascript')) {
      throw new Error(`desktop transport: bundle has unsupported media type ${response.contentType}`)
    }
    const source = new TextDecoder().decode(response.body)
      .replace(/^\/\/# sourceMappingURL=.*$/gmu, '')
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = blobUrl
        script.onload = () => { script.remove(); resolve() }
        script.onerror = () => { script.remove(); reject(new Error(`desktop transport: bundle execution failed for ${url}`)) }
        document.head.append(script)
      })
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }

  /** Close the port and reject every operation that has not settled. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.port.removeEventListener('message', this.onMessage)
    this.port.removeEventListener('messageerror', this.onMessageError)
    this.port.removeEventListener('close', this.onClose)
    this.port.close()
    const error = new Error('desktop transport closed')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const streamId of [...this.streams.keys()]) this.finishStream(streamId, error)
  }

  private once(
    requestId: DesktopRequestId,
    frame: DesktopClientFrame,
    signal?: AbortSignal,
  ): Promise<DesktopHostFrame> {
    if (this.closed) return Promise.reject(new Error('desktop transport closed'))
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(requestId)
        this.post({ v: 1, t: 'abort', id: requestId })
        reject(rejectionError(signal?.reason, 'desktop request aborted'))
      }
      this.pending.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (reason) => {
          signal?.removeEventListener('abort', abort)
          reject(rejectionError(reason, 'desktop request failed'))
        },
      })
      if (signal?.aborted === true) abort()
      else {
        signal?.addEventListener('abort', abort, { once: true })
        this.post(frame)
      }
    })
  }

  private post(frame: DesktopClientFrame): void {
    if (this.closed) throw new Error('desktop transport closed')
    this.port.postMessage(frame)
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    let frame: DesktopHostFrame
    try {
      frame = parseDesktopHostFrame(event.data)
    } catch {
      this.close()
      return
    }
    if (frame.t === 'stream-ready') {
      this.streams.get(frame.id)?.resolveReady()
      return
    }
    if (frame.t === 'stream-item' || frame.t === 'stream-end') {
      const stream = this.streams.get(frame.id)
      stream?.next?.resolve(frame)
      if (frame.t === 'stream-end') this.finishStream(frame.id)
      return
    }
    if (frame.t === 'stream-error') {
      this.finishStream(frame.id, errorOf(frame))
      return
    }
    if (frame.t === 'fault' && this.streams.has(frame.id)) {
      this.finishStream(frame.id, errorOf(frame))
      return
    }
    const pending = this.pending.get(frame.id)
    if (pending === undefined) return
    this.pending.delete(frame.id)
    if (frame.t === 'fault') pending.reject(errorOf(frame))
    else pending.resolve(frame)
  }

  private readonly onMessageError = (): void => {
    this.close()
  }

  private readonly onClose = (): void => {
    this.close()
  }

  private finishStream(streamId: DesktopRequestId, reason?: unknown): void {
    const stream = this.streams.get(streamId)
    if (stream === undefined) return
    this.streams.delete(streamId)
    stream.closed = true
    stream.cleanup()
    if (reason === undefined) {
      stream.resolveReady()
      stream.next?.resolve({ v: 1, t: 'stream-end', id: streamId })
    } else {
      stream.rejectReady(reason)
      stream.next?.reject(reason)
    }
    stream.next = undefined
  }
}
