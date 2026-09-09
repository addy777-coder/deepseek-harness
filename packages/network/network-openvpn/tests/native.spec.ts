/** Native framing, artifact integrity, and quiescent shutdown without a live VPN. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSession, verifyExecutable } from '../src/native.ts'
import type { NativeEvent } from '../src/native.ts'
import type { ResolvedSpec } from '../src/types.ts'
import { ScriptedProcesses } from './process-fixture.ts'

const contexts: Context[] = []
const sessions: NativeSession[] = []
const directories: string[] = []
const spec: ResolvedSpec = {
  executablePath: 'fixture-native.exe', cwd: '.', connectTimeoutSeconds: 1, shutdownGraceMs: 100,
  reconnectDelayMs: 100, reconnectMaxDelayMs: 1000, maxConnections: 2, headerTimeoutMs: 100,
  targetConnectTimeoutMs: 100, pollIntervalMs: 10, maxPendingPacketBytes: 65536, maxProfileBytes: 1024,
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const session of sessions.splice(0)) await session.close()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function sessionFor(bootstrap: Record<string, unknown> = { password: 'private-password' }) {
  const ctx = new Context()
  contexts.push(ctx)
  const processes = new ScriptedProcesses(ctx)
  const events: NativeEvent[] = []
  const session = new NativeSession(processes, spec, bootstrap, event => events.push(event))
  sessions.push(session)
  return { session, processes, child: processes.children[0]!, events }
}

describe('native helper protocol', () => {
  it('sends credentials only through stdin and reads split/coalesced status records', async () => {
    const { session, processes, child, events } = sessionFor()
    expect(processes.spawns).toEqual([{ argv: [spec.executablePath], cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 }])
    expect(child.input).toBe('{"password":"private-password"}\n')
    child.stdout.write('{"event":"proxy-')
    child.stdout.write('ready","port":23456,"secret":"discard-me"}\n{"event":"connected"}\n')
    await expect(session.ready).resolves.toBe(23456)
    expect(events).toEqual([{ event: 'proxy-ready', port: 23456 }, { event: 'connected' }])
    expect(JSON.stringify(events)).not.toContain('private-password')
    await session.close()
    expect(child.terminateCalls).toBe(0)
    expect(child.waitForExitCalls).toBe(1)
  })

  it.each([
    'not-json\n',
    '{"event":"proxy-ready","port":0}\n',
    '{"event":"password=secret"}\n',
    'x'.repeat(65537),
  ])('rejects invalid native output and waits for its process to close', async (output) => {
    const { session, child, events } = sessionFor()
    const failed = expect(session.ready).rejects.toMatchObject({ code: 'VPN_NATIVE_PROTOCOL_INVALID' })
    child.stdout.write(output)
    await failed
    await session.close()
    expect(events).toContainEqual({ event: 'VPN_NATIVE_PROTOCOL_INVALID', error: true })
    expect(child.stdin.writableEnded).toBe(true)
    expect(child.waitForExitCalls).toBe(1)
  })

  it('publishes fatal protocol failure even after readiness resolved', async () => {
    const { session, child, events } = sessionFor()
    child.emit({ event: 'proxy-ready', port: 23456 })
    await session.ready
    child.stdout.write('invalid after ready\n')
    await session.close()
    expect(events.at(-1)).toEqual({ event: 'VPN_NATIVE_PROTOCOL_INVALID', error: true })
  })

  it('reports a failed tree join without forwarding the subprocess error text', async () => {
    const { session, child, events } = sessionFor()
    child.autoExitOnEof = false
    child.stdout.write('invalid native output\n')
    const closed = session.close()
    const failure = expect(closed).rejects.toThrow('tree join failed')
    child.exit(0, { treeExited: false })
    child.tree.reject(new Error('tree join failed with private metadata'))
    await failure
    await vi.waitFor(() => { expect(events.at(-1)).toEqual({ event: 'VPN_SHUTDOWN_FAILED', error: true }) })
    expect(JSON.stringify(events)).not.toContain('private metadata')
    sessions.splice(sessions.indexOf(session), 1)
  })

  it('rejects native authentication errors with their sanitized event code', async () => {
    const { session, child, events } = sessionFor()
    const failed = expect(session.ready).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    child.emit({ event: 'AUTH_FAILED', error: true, password: 'do-not-forward' })
    await failed
    await session.close()
    expect(events).toEqual([{ event: 'AUTH_FAILED', error: true }])
  })

  it.each(['stdin', 'stdout', 'stderr'] as const)('contains %s failures and closes its helper', async (pipe) => {
    const { session, child } = sessionFor()
    const failed = expect(session.ready).rejects.toMatchObject({
      code: pipe === 'stdin' ? 'VPN_NATIVE_INPUT_FAILED' : 'VPN_NATIVE_PROTOCOL_INVALID',
    })
    child[pipe].emit('error', new Error('sensitive native output'))
    await failed
    await session.close()
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('rejects readiness when the helper exits before the proxy is ready', async () => {
    const { session, child } = sessionFor()
    const failed = expect(session.ready).rejects.toMatchObject({ code: 'VPN_NATIVE_EXITED' })
    child.exit(2)
    await failed
    await expect(session.done).resolves.toBe(2)
  })

  it('contains spawn failure and still waits for tree cleanup', async () => {
    const { session, child } = sessionFor()
    child.completion.reject(new Error('failed spawn with secret arguments'))
    child.releaseTree()
    await expect(session.done).resolves.toBeNull()
    await session.close()
    expect(child.waitForExitCalls).toBe(1)
  })

  it.each([[true, 0], [false, 0], [true, 1]] as const)('requires accepted=%s and zero exit (actual=%s) for evaluation', async (accepted, code) => {
    const { session, child } = sessionFor({ evaluateOnly: true })
    const outcome = session.evaluated()
    const assertion = accepted && code === 0
      ? expect(outcome).resolves.toMatchObject({ event: 'profile-evaluated', accepted: true })
      : expect(outcome).rejects.toMatchObject({ code: 'VPN_PROFILE_REJECTED' })
    child.emit({ event: 'profile-evaluated', accepted, requiresChallenge: false })
    child.exit(code)
    await assertion
    expect(child.waitForExitCalls).toBe(1)
  })

  it('holds close until the process tree exits and shares repeated close calls', async () => {
    const { session, child } = sessionFor()
    child.autoExitOnEof = false
    child.exit(0, { treeExited: false })
    await session.done
    const first = session.close()
    expect(session.close()).toBe(first)
    await vi.waitFor(() => { expect(child.waitForExitCalls).toBe(1) })
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.releaseTree()
    await first
    expect(settled).toBe(true)
  })

  it('terminates an EOF-resistant helper after the configured grace period', async () => {
    vi.useFakeTimers()
    const { session, child } = sessionFor()
    child.autoExitOnEof = false
    const closed = session.close()
    await vi.advanceTimersByTimeAsync(spec.shutdownGraceMs - 1)
    expect(child.terminateCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await closed
    expect(child.terminateCalls).toBe(1)
    expect(child.waitForExitCalls).toBe(1)
  })

  it('closes a helper that does not publish readiness before the connection deadline', async () => {
    vi.useFakeTimers()
    const { session, child, events } = sessionFor()
    const failure = expect(session.ready).rejects.toMatchObject({ code: 'VPN_CONNECT_TIMEOUT' })
    await vi.advanceTimersByTimeAsync((spec.connectTimeoutSeconds + 5) * 1000)
    await failure
    await session.close()
    expect(events).toContainEqual({ event: 'VPN_CONNECT_TIMEOUT', error: true })
    expect(child.stdin.writableEnded).toBe(true)
  })
})

describe('native artifact integrity', () => {
  async function artifact(): Promise<ResolvedSpec> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-digest-'))
    directories.push(directory)
    const executablePath = join(directory, 'dsh-vpn.exe')
    await writeFile(executablePath, 'fixture native executable')
    return { ...spec, executablePath }
  }

  it('checks an explicit digest and an adjacent checksum file', async () => {
    const candidate = await artifact()
    const digest = createHash('sha256').update('fixture native executable').digest('hex')
    await expect(verifyExecutable({ ...candidate, executableSha256: digest.toUpperCase() })).resolves.toBeUndefined()
    await writeFile(`${candidate.executablePath}.sha256`, `${digest}  dsh-vpn.exe\n`)
    await expect(verifyExecutable(candidate)).resolves.toBeUndefined()
    await writeFile(candidate.executablePath, 'tampered executable')
    await expect(verifyExecutable(candidate)).rejects.toMatchObject({ code: 'VPN_RUNTIME_INTEGRITY_FAILED' })
  })

  it('rejects missing checksum assets and malformed digests without exposing file errors', async () => {
    const candidate = await artifact()
    await expect(verifyExecutable(candidate)).rejects.toMatchObject({ code: 'VPN_RUNTIME_MISSING' })
    await expect(verifyExecutable({ ...candidate, executableSha256: 'not-a-digest' }))
      .rejects.toMatchObject({ code: 'VPN_RUNTIME_INTEGRITY_FAILED' })
  })
})
