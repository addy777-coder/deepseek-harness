import { describe, expect, it } from 'vitest'
import { parseDesktopHostControlFrame, parseDesktopHostLifecycleFrame } from '../src/index.ts'
import type { DesktopHostFrame, DesktopRequestId } from '../src/protocol.ts'
import {
  DesktopPortServer,
  parseDesktopClientFrame,
  type DesktopPortServices,
} from '../src/server.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

class FakePort {
  readonly sent: DesktopHostFrame[] = []
  startCount = 0
  closeCount = 0
  private readonly messageListeners = new Set<(event: { readonly data: unknown }) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly waiters = new Set<(frame: DesktopHostFrame) => void>()

  postMessage(frame: DesktopHostFrame): void {
    this.sent.push(frame)
    for (const waiter of [...this.waiters]) waiter(frame)
  }

  start(): void { this.startCount += 1 }
  close(): void { this.closeCount += 1 }

  on(event: string, listener: ((event: { readonly data: unknown }) => void) | (() => void)): this {
    if (event === 'message') this.messageListeners.add(listener)
    else this.closeListeners.add(listener as () => void)
    return this
  }

  off(event: string, listener: ((event: { readonly data: unknown }) => void) | (() => void)): this {
    if (event === 'message') this.messageListeners.delete(listener)
    else this.closeListeners.delete(listener as () => void)
    return this
  }

  receive(data: unknown): void {
    for (const listener of [...this.messageListeners]) listener({ data })
  }

  waitFor(type: DesktopHostFrame['t']): Promise<DesktopHostFrame> {
    const existing = this.sent.find(frame => frame.t === type)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const waiter = (frame: DesktopHostFrame): void => {
        if (frame.t !== type) return
        this.waiters.delete(waiter)
        resolve(frame)
      }
      this.waiters.add(waiter)
    })
  }
}

const requestId = (value: string): DesktopRequestId => value as DesktopRequestId

function serviceFixture(overrides: Partial<DesktopPortServices> = {}): DesktopPortServices {
  return {
    boot: { collect: () => [] } as unknown as DesktopPortServices['boot'],
    modules: { artifact: () => undefined } as unknown as DesktopPortServices['modules'],
    fetch: { fetch: async () => new Response(null, { status: 204 }) },
    gateway: {
      wireStream: {
        open: async () => ({ async *[Symbol.asyncIterator]() {} }),
        failure: (reason: unknown) => ({
          code: 'gateway/internal',
          message: reason instanceof Error ? reason.message : String(reason),
          details: {},
        }),
      },
    } as unknown as DesktopPortServices['gateway'],
    maxBodyBytes: 1024,
    ...overrides,
  }
}

function serverFixture(overrides: Partial<DesktopPortServices> = {}): {
  readonly port: FakePort
  readonly server: DesktopPortServer
} {
  const port = new FakePort()
  const server = new DesktopPortServer(port, serviceFixture(overrides))
  return { port, server }
}

describe('DesktopPortServer', () => {
  it('strictly parses main-process control frames', () => {
    expect(parseDesktopHostControlFrame({ v: 1, t: 'shutdown' })).toEqual({ v: 1, t: 'shutdown' })
    expect(parseDesktopHostControlFrame({ v: 1, t: 'attach', windowId: 'window-1' }))
      .toEqual({ v: 1, t: 'attach', windowId: 'window-1' })
    expect(() => parseDesktopHostControlFrame({ v: 1, t: 'shutdown', extra: true }))
      .toThrow('invalid shutdown frame')
    expect(() => parseDesktopHostControlFrame({ v: 1, t: 'attach', windowId: 'x'.repeat(129) }))
      .toThrow('invalid attach frame')
  })

  it('strictly parses Utility Process lifecycle frames', () => {
    expect(parseDesktopHostLifecycleFrame({ v: 1, t: 'startup', phase: 'profile' }))
      .toEqual({ v: 1, t: 'startup', phase: 'profile' })
    expect(parseDesktopHostLifecycleFrame({ v: 1, t: 'ready' })).toEqual({ v: 1, t: 'ready' })
    expect(() => parseDesktopHostLifecycleFrame({ v: 1, t: 'ready', extra: true }))
      .toThrow('invalid ready lifecycle frame')
    expect(() => parseDesktopHostLifecycleFrame({ v: 1, t: 'startup', phase: 'unknown' }))
      .toThrow('invalid lifecycle frame')
  })

  it('strictly parses versioned client frames and faults a correlated invalid frame', async () => {
    expect(parseDesktopClientFrame({ v: 1, t: 'boot', id: 'boot-1' })).toEqual({ v: 1, t: 'boot', id: 'boot-1' })
    expect(() => parseDesktopClientFrame({ v: 1, t: 'boot', id: 'boot-1', extra: true })).toThrow('invalid boot frame')
    expect(() => parseDesktopClientFrame({
      v: 1,
      t: 'fetch',
      id: 'fetch-1',
      url: 'http://dsh.internal/api/test',
      method: 'POST',
      headers: [],
      body: new Uint8Array(),
    })).toThrow('invalid fetch frame')

    const { port, server } = serverFixture()
    expect(port.startCount).toBe(1)
    port.receive({ v: 1, t: 'boot', id: 'fault-1', extra: true })
    await expect(port.waitFor('fault')).resolves.toMatchObject({
      id: 'fault-1',
      message: 'desktop transport: invalid boot frame',
    })
    await server.dispose()
  })

  it('aborts an in-flight fetch and rejects a duplicate active id', async () => {
    const entered = deferred<AbortSignal>()
    const aborted = deferred<undefined>()
    const { port, server } = serverFixture({
      fetch: {
        fetch: async (request) => {
          entered.resolve(request.signal)
          return await new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => {
              aborted.resolve(undefined)
              reject(request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error('fetch aborted'))
            }, { once: true })
          })
        },
      },
    })
    const id = requestId('fetch-active')
    const frame = {
      v: 1 as const,
      t: 'fetch' as const,
      id,
      url: 'http://dsh.internal/api/test',
      method: 'GET',
      headers: [],
    }
    port.receive(frame)
    const signal = await entered.promise
    port.receive(frame)
    await expect(port.waitFor('fault')).resolves.toMatchObject({
      id,
      message: 'desktop transport: duplicate fetch fetch-active',
    })
    port.receive({ v: 1, t: 'abort', id })
    await aborted.promise
    expect(signal.aborted).toBe(true)
    await server.dispose()
  })

  it('pulls at most one stream item per client demand', async () => {
    let nextCalls = 0
    const iterator: AsyncIterator<unknown> = {
      next: async () => {
        nextCalls += 1
        return nextCalls === 1
          ? { done: false, value: 'one' }
          : { done: true, value: undefined }
      },
    }
    const { port, server } = serverFixture({
      gateway: {
        wireStream: {
          open: async () => ({ [Symbol.asyncIterator]: () => iterator }),
          failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }),
        },
      } as unknown as DesktopPortServices['gateway'],
    })
    const id = requestId('stream-demand')
    port.receive({ v: 1, t: 'stream-open', id, endpoint: 'sessions/follow', payload: {} })
    await port.waitFor('stream-ready')
    expect(nextCalls).toBe(0)

    port.receive({ v: 1, t: 'stream-pull', id })
    await expect(port.waitFor('stream-item')).resolves.toMatchObject({ id, value: 'one' })
    expect(nextCalls).toBe(1)

    port.receive({ v: 1, t: 'stream-pull', id })
    await expect(port.waitFor('stream-end')).resolves.toMatchObject({ id })
    expect(nextCalls).toBe(2)
    await server.dispose()
  })

  it('aborts a stream while its source is opening without publishing readiness', async () => {
    const opening = deferred<AsyncIterable<unknown>>()
    const entered = deferred<AbortSignal>()
    const returned = deferred<undefined>()
    const iterator: AsyncIterator<unknown> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        returned.resolve(undefined)
        return { done: true, value: undefined }
      },
    }
    const { port, server } = serverFixture({
      gateway: {
        wireStream: {
          open: async (_endpoint: string, _payload: unknown, signal: AbortSignal) => {
            entered.resolve(signal)
            return await opening.promise
          },
          failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }),
        },
      } as unknown as DesktopPortServices['gateway'],
    })
    const id = requestId('stream-opening')
    port.receive({ v: 1, t: 'stream-open', id, endpoint: 'sessions/follow', payload: {} })
    const signal = await entered.promise
    port.receive({ v: 1, t: 'abort', id })
    expect(signal.aborted).toBe(true)
    opening.resolve({ [Symbol.asyncIterator]: () => iterator })
    await returned.promise
    expect(port.sent.some(frame => frame.t === 'stream-ready')).toBe(false)
    await server.dispose()
  })

  it('waits for iterator disposal before closing its port', async () => {
    const release = deferred<IteratorResult<unknown>>()
    const returnEntered = deferred<undefined>()
    const iterator: AsyncIterator<unknown> = {
      next: async () => ({ done: false, value: 'unused' }),
      return: async () => {
        returnEntered.resolve(undefined)
        return await release.promise
      },
    }
    const { port, server } = serverFixture({
      gateway: {
        wireStream: {
          open: async () => ({ [Symbol.asyncIterator]: () => iterator }),
          failure: () => ({ code: 'gateway/internal', message: 'failed', details: {} }),
        },
      } as unknown as DesktopPortServices['gateway'],
    })
    port.receive({
      v: 1,
      t: 'stream-open',
      id: requestId('stream-dispose'),
      endpoint: 'sessions/follow',
      payload: {},
    })
    await port.waitFor('stream-ready')
    let settled = false
    const disposal = server.dispose().then(() => { settled = true })
    await returnEntered.promise
    expect(settled).toBe(false)
    expect(port.closeCount).toBe(0)
    release.resolve({ done: true, value: undefined })
    await disposal
    expect(port.closeCount).toBe(1)
  })
})
