/** Managed helper protocol, verified executable loading, and awaited shutdown. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { NetworkError } from '@deepseek-ai/dsh-network'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { ResolvedSpec } from './types.ts'

const eventSchema = z.object({
  event: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
  port: z.number().int().min(1).max(65535).optional(),
  accepted: z.boolean().optional(),
  error: z.boolean().optional(),
  requiresChallenge: z.boolean().optional(),
  requiresPrivateKeyPassword: z.boolean().optional(),
  requiresExternalPki: z.boolean().optional(),
})

/** Validated native status without arbitrary process output. */
export type NativeEvent = z.infer<typeof eventSchema>

/**
 * Check the native artifact against the configured or bundled digest.
 * @param spec - resolved helper location and optional expected SHA256.
 * @returns settlement after the executable matches; missing or corrupt assets reject.
 */
export async function verifyExecutable(spec: ResolvedSpec): Promise<void> {
  let executable: Buffer
  let digest: string
  try {
    executable = await readFile(spec.executablePath)
    digest = spec.executableSha256 ?? ((await readFile(`${spec.executablePath}.sha256`, 'utf8')).trim().split(/\s/u)[0] as string)
  } catch { throw new NetworkError('VPN_RUNTIME_MISSING') }
  if (!/^[a-f0-9]{64}$/iu.test(digest) || createHash('sha256').update(executable).digest('hex') !== digest.toLowerCase()) {
    throw new NetworkError('VPN_RUNTIME_INTEGRITY_FAILED')
  }
}

/** One native helper; keeping stdin open owns its lifetime even if the Host crashes. */
export class NativeSession {
  /** Port of the authenticated loopback CONNECT proxy after the tunnel becomes usable. */
  readonly ready: Promise<number>
  /** Native process exit code after all process handles and pipes close. */
  readonly done: Promise<number | null>
  private readonly child: SubprocessHandle & { stdin: Writable; stdout: Readable; stderr: Readable }
  private readonly readiness = Promise.withResolvers<number>()
  private readonly evaluation = Promise.withResolvers<NativeEvent>()
  private buffer = ''
  private finished = false
  private closing: Promise<void> | undefined
  private readonly timer: ReturnType<typeof setTimeout>

  /**
   * @param processes - local managed process service.
   * @param spec - verified executable and explicit resource limits.
   * @param bootstrap - one in-memory startup message; never sent through argv or the environment.
   * @param onEvent - validated, sanitized status receiver.
   */
  constructor(processes: SubprocessRuntime, private readonly spec: ResolvedSpec,
    bootstrap: Record<string, unknown>, private readonly onEvent: (event: NativeEvent) => void) {
    this.ready = this.readiness.promise
    void this.ready.catch(() => { /* Evaluate-only sessions consume evaluation instead. */ })
    void this.evaluation.promise.catch(() => { /* Connected sessions consume readiness instead. */ })
    this.child = processes.spawn({ argv: [spec.executablePath], cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: spec.shutdownGraceMs }) as typeof this.child
    this.timer = setTimeout(() => {
      this.fail('VPN_CONNECT_TIMEOUT')
      this.requestClose()
    }, (spec.connectTimeoutSeconds + 5) * 1000)
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => { this.receive(chunk) })
    this.child.stdout.on('error', () => { this.fail('VPN_NATIVE_PROTOCOL_INVALID'); this.requestClose() })
    this.child.stderr.on('error', () => { this.fail('VPN_NATIVE_PROTOCOL_INVALID'); this.requestClose() }).resume()
    this.child.stdin.on('error', () => { this.fail('VPN_NATIVE_INPUT_FAILED'); this.requestClose() })
    this.done = this.child.done.then(result => result.exitCode, () => null).then((code) => {
      this.finished = true
      clearTimeout(this.timer)
      this.readiness.reject(new NetworkError('VPN_NATIVE_EXITED'))
      this.evaluation.reject(new NetworkError('VPN_NATIVE_EXITED'))
      return code
    })
    this.child.stdin.write(`${JSON.stringify(bootstrap)}\n`)
  }

  /**
   * Read the profile verdict from an evaluate-only helper.
   * @returns the evaluated profile metadata after the helper exits successfully.
   */
  async evaluated(): Promise<NativeEvent> {
    try {
      const event = await this.evaluation.promise
      if (await this.done !== 0 || !event.accepted) throw new NetworkError('VPN_PROFILE_REJECTED')
      return event
    } finally { await this.close() }
  }

  /**
   * Close the helper and wait for its complete process tree to stop.
   * @returns settlement after EOF shutdown or managed tree termination reaches quiescence.
   */
  close(): Promise<void> {
    return this.closing ??= this.stop()
  }

  private async stop(): Promise<void> {
    clearTimeout(this.timer)
    if (!this.finished) this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const exited = await Promise.race([
        this.done.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, this.spec.shutdownGraceMs) }),
      ])
      if (!exited) this.child.terminate()
      await this.done
      await this.child.waitForExit()
    } finally { clearTimeout(timer) }
  }

  private fail(code: string): void {
    const error = new NetworkError(code)
    this.readiness.reject(error)
    this.evaluation.reject(error)
    this.onEvent({ event: code, error: true })
  }

  private requestClose(): void {
    void this.close().catch(() => { this.fail('VPN_SHUTDOWN_FAILED') })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 65536) {
      this.fail('VPN_NATIVE_PROTOCOL_INVALID')
      this.requestClose()
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      let event: NativeEvent
      try { event = eventSchema.parse(JSON.parse(line)) }
      catch { this.fail('VPN_NATIVE_PROTOCOL_INVALID'); this.requestClose(); return }
      if (event.error) { this.fail(event.event); this.requestClose(); return }
      if (event.event === 'profile-evaluated') this.evaluation.resolve(event)
      if (event.event === 'proxy-ready' && event.port !== undefined) {
        clearTimeout(this.timer)
        this.readiness.resolve(event.port)
      }
      this.onEvent(event)
    }
  }
}
