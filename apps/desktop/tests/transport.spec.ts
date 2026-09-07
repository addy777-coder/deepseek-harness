import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { DesktopTransportClient, parseDesktopHostFrame } from '../src/renderer/transport.ts'

interface ReceivedFrame {
  readonly v: number
  readonly t: string
  readonly id: string
  readonly [key: string]: unknown
}

class HostPeer {
  private readonly received: ReceivedFrame[] = []
  private readonly waiters = new Set<(frame: ReceivedFrame) => void>()

  constructor(readonly port: NodeMessagePort) {
    port.on('message', (value: unknown) => {
      const frame = value as ReceivedFrame
      this.received.push(frame)
      for (const waiter of [...this.waiters]) waiter(frame)
    })
  }

  waitFor(type: string): Promise<ReceivedFrame> {
    const index = this.received.findIndex(frame => frame.t === type)
    if (index >= 0) return Promise.resolve(this.received.splice(index, 1)[0])
    return new Promise((resolve) => {
      const waiter = (frame: ReceivedFrame): void => {
        if (frame.t !== type) return
        this.waiters.delete(waiter)
        const receivedIndex = this.received.indexOf(frame)
        if (receivedIndex >= 0) this.received.splice(receivedIndex, 1)
        resolve(frame)
      }
      this.waiters.add(waiter)
    })
  }

  count(type: string): number {
    return this.received.filter(frame => frame.t === type).length
  }

  send(frame: object, transfer: Transferable[] = []): void {
    this.port.postMessage(frame, transfer as never[])
  }

  close(): void { this.port.close() }
}

function fixture(): { readonly client: DesktopTransportClient; readonly peer: HostPeer } {
  const { port1, port2 } = new MessageChannel()
  return {
    client: new DesktopTransportClient(port1 as unknown as MessagePort),
    peer: new HostPeer(port2),
  }
}

describe('DesktopTransportClient', () => {
  it('strictly parses Host frames', () => {
    expect(parseDesktopHostFrame({ v: 1, t: 'stream-ready', id: 'one' }))
      .toEqual({ v: 1, t: 'stream-ready', id: 'one' })
    expect(() => parseDesktopHostFrame({ v: 1, t: 'stream-ready', id: 'one', extra: true }))
      .toThrow('invalid stream-ready frame')
    expect(() => parseDesktopHostFrame({
      v: 1,
      t: 'fetch-result',
      id: 'one',
      status: 200,
      statusText: 'OK',
      headers: [],
      body: new Uint8Array(),
    })).toThrow('invalid fetch-result frame')
  })

  it('carries a binary request body and accepts a bodyless response status', async () => {
    const { client, peer } = fixture()
    const responsePromise = client.fetch('http://dsh.internal/api/test', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    })
    const request = await peer.waitFor('fetch')
    expect(request.body).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(request.body as ArrayBuffer)]).toEqual([1, 2, 3])
    const body = new ArrayBuffer(0)
    peer.send({
      v: 1,
      t: 'fetch-result',
      id: request.id,
      status: 204,
      statusText: 'No Content',
      headers: [],
      body,
    }, [body])
    const response = await responsePromise
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    client.close()
    peer.close()
  })

  it('requests one stream item at a time and completes on stream-end', async () => {
    const { client, peer } = fixture()
    const controller = new AbortController()
    const source = client.openStream('sessions/follow', {}, controller.signal)
    const iterator = source[Symbol.asyncIterator]()
    const firstPromise = iterator.next()
    const open = await peer.waitFor('stream-open')
    peer.send({ v: 1, t: 'stream-ready', id: open.id })
    await peer.waitFor('stream-pull')
    peer.send({ v: 1, t: 'stream-item', id: open.id, value: 'one' })
    await expect(firstPromise).resolves.toEqual({ done: false, value: 'one' })

    const secondPromise = iterator.next()
    await peer.waitFor('stream-pull')
    peer.send({ v: 1, t: 'stream-end', id: open.id })
    await expect(secondPromise).resolves.toEqual({ done: true, value: undefined })
    controller.abort()
    await new Promise(resolve => setImmediate(resolve))
    expect(peer.count('abort')).toBe(0)
    client.close()
    peer.close()
  })

  it('rejects an opening stream when the Host returns a correlated fault', async () => {
    const { client, peer } = fixture()
    const source = client.openStream('sessions/follow', {}, new AbortController().signal)
    const next = source[Symbol.asyncIterator]().next()
    const open = await peer.waitFor('stream-open')
    peer.send({ v: 1, t: 'fault', id: open.id, message: 'open failed' })
    await expect(next).rejects.toThrow('open failed')
    client.close()
    peer.close()
  })

  it('closes and rejects pending work after a malformed Host frame', async () => {
    const { client, peer } = fixture()
    const boot = client.boot()
    const request = await peer.waitFor('boot')
    peer.send({ v: 1, t: 'boot-result', id: request.id, injections: [], extra: true })
    await expect(boot).rejects.toThrow('desktop transport closed')
    peer.close()
  })

  it('rejects pending work when the Host closes its port', async () => {
    const { client, peer } = fixture()
    const boot = client.boot()
    await peer.waitFor('boot')
    peer.close()
    await expect(boot).rejects.toThrow('desktop transport closed')
  })
})
