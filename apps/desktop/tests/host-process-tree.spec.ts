import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createPosixProcessInspector,
  type ProcessIdentity,
  type ProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/posix-process-inspector'
import { HostProcessTree, waitForHostExit } from '../src/main/host-process-tree.ts'

interface Entry extends ProcessIdentity { parent: number }

function fakeInspector(entries: Entry[]) {
  const rows = new Map(entries.map(entry => [entry.pid, entry]))
  const signals: ProcessIdentity[] = []
  const inspector: Pick<ProcessInspector, 'snapshot' | 'signalProcess'> = {
    snapshot() {
      const observed = [...rows.values()]
      const tree = (pid: number): ProcessIdentity[] => {
        const root = observed.find(entry => entry.pid === pid)
        return root === undefined ? [] : [
          ...observed.filter(entry => entry.parent === pid).flatMap(entry => tree(entry.pid)),
          { pid: root.pid, started: root.started },
        ]
      }
      return {
        tree,
        session: () => [],
        alive: member => observed.some(entry => entry.pid === member.pid && entry.started === member.started),
      }
    },
    signalProcess(member) {
      if (rows.get(member.pid)?.started !== member.started) return
      signals.push(member)
      rows.delete(member.pid)
    },
  }
  return { inspector, rows, signals }
}

afterEach(() => { vi.useRealTimers() })

describe('Desktop Host process ownership', () => {
  it('retains reparented descendants, discovers their children, and leaves unrelated processes alive', async () => {
    const fake = fakeInspector([
      { pid: 10, started: 'root', parent: 1 },
      { pid: 11, started: 'child', parent: 10 },
      { pid: 90, started: 'unrelated', parent: 1 },
    ])
    const tree = new HostProcessTree(10, fake.inspector)
    fake.rows.delete(10)
    fake.rows.set(11, { pid: 11, started: 'child', parent: 1 })
    fake.rows.set(12, { pid: 12, started: 'grandchild', parent: 11 })

    await tree.terminate(1_000)

    expect(fake.signals).toEqual([{ pid: 12, started: 'grandchild' }, { pid: 11, started: 'child' }])
    expect([...fake.rows.keys()]).toEqual([90])
  })

  it('never adopts children from a recycled root or descendant PID', async () => {
    const fake = fakeInspector([
      { pid: 10, started: 'root', parent: 1 },
      { pid: 11, started: 'child', parent: 10 },
    ])
    const tree = new HostProcessTree(10, fake.inspector)
    fake.rows.set(10, { pid: 10, started: 'replacement', parent: 1 })
    fake.rows.set(11, { pid: 11, started: 'replacement-child', parent: 10 })
    fake.rows.set(12, { pid: 12, started: 'unrelated', parent: 11 })

    await tree.terminate(1_000)

    expect(fake.signals).toEqual([])
    expect(fake.rows.size).toBe(3)
  })

  it('waits for quiescence after SIGKILL rather than returning after signal delivery', async () => {
    const fake = fakeInspector([{ pid: 10, started: 'root', parent: 1 }])
    const tree = new HostProcessTree(10, fake.inspector)
    fake.inspector.signalProcess = vi.fn(() => {})
    let settled = false
    const pending = tree.terminate(1_000).then(() => { settled = true })
    expect(settled).toBe(false)
    expect(fake.inspector.signalProcess).toHaveBeenCalledWith({ pid: 10, started: 'root' }, 'SIGKILL')
    fake.rows.delete(10)
    await pending
    expect(settled).toBe(true)
  })

  it('reports surviving identities and signal failures, and allows a later cleanup retry', async () => {
    const fake = fakeInspector([
      { pid: 10, started: 'root', parent: 1 },
      { pid: 11, started: 'child', parent: 10 },
    ])
    const tree = new HostProcessTree(10, fake.inspector)
    const error = Object.assign(new Error('operation denied'), { code: 'EPERM' })
    const signal = fake.inspector.signalProcess
    fake.inspector.signalProcess = (member, name) => {
      if (member.pid === 11) throw error
      signal(member, name)
    }

    await expect(tree.terminate(0)).rejects.toMatchObject({
      message: 'desktop host: process tree did not stop after 0 ms; surviving processes: 11 (child)',
      errors: [error],
    })
    fake.inspector.signalProcess = signal
    await tree.terminate(1_000)
    expect(fake.rows.size).toBe(0)
  })

  it('contains an exit race without skipping other owned descendants', async () => {
    const fake = fakeInspector([
      { pid: 10, started: 'root', parent: 1 },
      { pid: 11, started: 'child', parent: 10 },
    ])
    const tree = new HostProcessTree(10, fake.inspector)
    const signal = fake.inspector.signalProcess
    fake.inspector.signalProcess = (member, name) => {
      signal(member, name)
      if (member.pid === 11) throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    }
    await tree.terminate(1_000)
    expect(fake.rows.size).toBe(0)
  })

  it('rejects an unobservable root before sending any signals', () => {
    const fake = fakeInspector([])
    expect(() => new HostProcessTree(10, fake.inspector)).toThrow('cannot identify owned process 10')
    expect(fake.signals).toEqual([])
  })

  it('bounds missing Electron exit notifications and clears the timer after completion', async () => {
    vi.useFakeTimers()
    const pending = waitForHostExit(new Promise(() => {}), 1_000)
    const rejected = expect(pending).rejects.toThrow('exit was not reported after 1000 ms')
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await waitForHostExit(Promise.resolve(), 1_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

const scenarioTimeoutMs = 30_000
const idleScript = "process.on('SIGTERM', () => {}); if (process.send) process.send({ ready: true }); setInterval(() => {}, 1000)"
const rootScript = `
  const { spawn } = require('node:child_process')
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(idleScript)}], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  child.once('message', () => process.send({ descendant: child.pid }))
  child.once('error', error => { throw error })
  process.on('message', () => process.exit(0))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
`

async function ownFixture(script: string, inspector: ProcessInspector): Promise<{
  child: ChildProcess
  tree: HostProcessTree
  exited: Promise<void>
  message: Promise<unknown>
}> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => { resolve() })
    child.once('error', reject)
  })
  const message = once(child, 'message').then(([value]: unknown[]) => value)
  void message.catch(() => {})
  void exited.catch(() => {})
  const owner: { tree?: HostProcessTree } = {}
  onTestFinished(async () => {
    if (owner.tree !== undefined) await owner.tree.terminate(scenarioTimeoutMs)
    else child.kill('SIGKILL')
    await waitForHostExit(exited, scenarioTimeoutMs)
  })
  await once(child, 'spawn')
  if (child.pid === undefined) throw new Error('fixture has no process id')
  const tree = new HostProcessTree(child.pid, inspector)
  owner.tree = tree
  return { child, tree, exited, message }
}

describe.skipIf(process.platform === 'win32')('POSIX detached command groups (requires POSIX process groups)', () => {
  it.each([false, true])('joins a detached descendant after the Host exits first: %s', async (exitRootFirst) => {
    const inspector = createPosixProcessInspector()
    const unrelated = await ownFixture(idleScript, inspector)
    await waitForHostExit(unrelated.message.then(() => {}), scenarioTimeoutMs)
    const owned = await ownFixture(rootScript, inspector)
    let message: unknown
    await waitForHostExit(owned.message.then((value) => { message = value }), scenarioTimeoutMs)
    if (typeof message !== 'object' || message === null || !('descendant' in message)
      || typeof message.descendant !== 'number' || owned.child.pid === undefined || unrelated.child.pid === undefined) {
      throw new Error('fixture did not report its descendant')
    }
    const descendant = message.descendant
    owned.tree.capture()
    const identities = inspector.snapshot().tree(owned.child.pid)
    expect(identities.some(member => member.pid === descendant)).toBe(true)
    const pgid = (pid: number) => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    expect(pgid(descendant)).toBe(descendant)
    expect(pgid(owned.child.pid)).not.toBe(descendant)
    if (exitRootFirst) {
      owned.child.send({ exit: true })
      await waitForHostExit(owned.exited, scenarioTimeoutMs)
    }

    await owned.tree.terminate(scenarioTimeoutMs)
    await waitForHostExit(owned.exited, scenarioTimeoutMs)

    expect(identities.every(member => !inspector.isAlive(member))).toBe(true)
    expect(inspector.snapshot().tree(unrelated.child.pid)).not.toEqual([])
  }, scenarioTimeoutMs * 4)
})
