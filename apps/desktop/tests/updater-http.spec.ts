import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestListener, type RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { CancellationToken } from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { describe, expect, it, vi } from 'vitest'

const installer = Buffer.from('complete installer contents')
const sha512 = createHash('sha512').update(installer).digest('base64')

interface DownloadFixture {
  readonly destination: string
  readonly requests: ClientRequest[]
  readonly writers: fs.WriteStream[]
  readonly writerOpened: Promise<void>
  download(token: CancellationToken, path?: string): Promise<string>
}

async function withDownloadFixture(handler: RequestListener, run: (fixture: DownloadFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updater-http-'))
  const destination = join(root, 'installer.exe')
  const server = createServer(handler)
  const requests: ClientRequest[] = []
  const writers: fs.WriteStream[] = []
  const tokens: CancellationToken[] = []
  const downloads: Promise<string>[] = []
  const writerOpened = Promise.withResolvers<undefined>()
  const createWriteStream = fs.createWriteStream
  const writerSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    const writer = createWriteStream(path, options)
    if (path === destination) {
      writers.push(writer)
      writer.once('open', () => { writerOpened.resolve(undefined) })
    }
    return writer
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP listener')
    const origin = `http://127.0.0.1:${address.port}`
    const executor = new ElectronHttpExecutor()
    executor.createRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = httpRequest({ ...options, agent: false }, (response) => {
        const location = response.headers.location
        if (location !== undefined && response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
          // Electron reports redirects on the request instead of delivering their response body.
          response.on('error', (error) => {
            if (!request.destroyed) throw error
          })
          request.emit('redirect', response.statusCode, 'GET', new URL(location, origin).href)
          response.resume()
        } else {
          callback(response)
        }
      })
      requests.push(request)
      // The updater uses the HTTP request's shared stream, abort, and event methods.
      return request as unknown as ReturnType<ElectronHttpExecutor['createRequest']>
    }
    await run({
      destination,
      requests,
      writers,
      writerOpened: writerOpened.promise,
      download(token, path = '/installer.exe') {
        tokens.push(token)
        const download = executor.download(new URL(path, origin), destination, {
          cancellationToken: token,
          sha512,
          onProgress: () => undefined,
        })
        downloads.push(download)
        // Cleanup observes rejections even when setup or an earlier assertion fails.
        void download.catch(() => undefined)
        return download
      },
    })
  } finally {
    try {
      for (const token of tokens) token.cancel()
      for (const request of requests) request.destroy()
      await Promise.all(writers.map(writer => new Promise<void>((resolve) => {
        if (writer.closed) {
          resolve()
        } else {
          writer.once('close', resolve)
          writer.destroy()
        }
      })))
      const stopped = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
      server.closeAllConnections()
      await stopped
      await Promise.allSettled(downloads)
    } finally {
      writerSpy.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
}

describe('updater HTTP cancellation', () => {
  it.each(['headers', 'body', 'redirect'] as const)('closes %s downloads before retrying the same file', async (stage) => {
    const received = Promise.withResolvers<undefined>()
    const disconnected = Promise.withResolvers<undefined>()
    let attempts = 0
    let connectionClosed = false
    await withDownloadFixture((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/installer.exe' }).end()
        return
      }
      attempts += 1
      if (attempts === 1) {
        response.once('close', () => {
          connectionClosed = true
          disconnected.resolve(undefined)
        })
        if (stage !== 'headers') {
          response.writeHead(200, { 'content-length': installer.length })
          response.write(installer.subarray(0, 1))
        }
        received.resolve(undefined)
      } else {
        response.writeHead(200, { 'content-length': installer.length }).end(installer)
      }
    }, async (fixture) => {
      const token = new CancellationToken()
      const first = fixture.download(token, stage === 'redirect' ? '/redirect' : '/installer.exe')
      await received.promise
      if (stage !== 'headers') await fixture.writerOpened
      expect(connectionClosed).toBe(false)
      token.cancel()
      await expect(first).rejects.toThrow('cancelled')
      expect(fixture.requests.at(-1)?.destroyed).toBe(true)
      expect(fixture.writers.every(writer => writer.closed)).toBe(true)
      const retry = fixture.download(new CancellationToken())
      await disconnected.promise
      await expect(retry).resolves.toBe(fixture.destination)
      expect(await readFile(fixture.destination)).toEqual(installer)
      expect(attempts).toBe(2)
      expect(fixture.writers.every(writer => writer.closed)).toBe(true)
      expect(token.listenerCount('cancel')).toBe(0)
    })
  })

  it.each(['checksum', 'connection'] as const)('releases the output file after a %s failure', async (failure) => {
    let interrupt: (() => void) | undefined
    await withDownloadFixture((_request, response) => {
      response.writeHead(200, { 'content-length': installer.length })
      if (failure === 'checksum') {
        response.end(Buffer.alloc(installer.length))
      } else {
        interrupt = () => response.destroy()
        response.write(installer.subarray(0, 1))
      }
    }, async (fixture) => {
      const download = fixture.download(new CancellationToken())
      await fixture.writerOpened
      if (failure === 'connection') {
        expect(interrupt).toBeDefined()
        interrupt!()
      }
      await expect(download).rejects.toThrow(failure === 'checksum' ? /checksum mismatch/i : /aborted|premature close/i)
      expect(fixture.writers).toHaveLength(1)
      expect(fixture.writers[0]?.closed).toBe(true)
    })
  })
})

describe('updater cancellation completion', () => {
  it.each(['resolve', 'reject'] as const)('waits for cleanup despite a late %s', async (completion) => {
    const token = new CancellationToken()
    const cleanup = Promise.withResolvers<undefined>()
    const operation = Promise.withResolvers<undefined>()
    const cleanupEntered = vi.fn()
    let settled = false
    const result = token.createPromise<undefined>((resolve, reject, onCancel) => {
      void operation.promise.then(resolve, reject)
      onCancel(async () => {
        cleanupEntered()
        await cleanup.promise
      })
    })
    void result.then(() => { settled = true }, () => { settled = true })
    try {
      token.cancel()
      token.cancel()
      expect(cleanupEntered).toHaveBeenCalledTimes(1)
      if (completion === 'resolve') operation.resolve(undefined)
      else operation.reject(new Error('late transport error'))
      // The next event-loop turn drains any settlement queued before cleanup completes.
      await setImmediate()
      expect(settled).toBe(false)
      cleanup.resolve(undefined)
      await expect(result).rejects.toThrow('cancelled')
      expect(token.listenerCount('cancel')).toBe(0)
    } finally {
      operation.resolve(undefined)
      cleanup.resolve(undefined)
      token.cancel()
      await Promise.allSettled([result])
    }
  })
})
