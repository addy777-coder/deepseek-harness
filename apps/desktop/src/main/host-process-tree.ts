/** Identity-fenced POSIX cleanup for the Desktop Host and its detached command groups. */

import { setTimeout as delay } from 'node:timers/promises'
import {
  createPosixProcessInspector,
  type ProcessIdentity,
  type ProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/posix-process-inspector'

type TreeInspector = Pick<ProcessInspector, 'snapshot' | 'signalProcess'>

/** Tracks observed descendants after reparenting and joins them after forced termination. */
export class HostProcessTree {
  private members: ProcessIdentity[]

  /**
   * @param pid - Utility Process PID, captured while the owned process is alive.
   * @param inspector - operating-system process table and identity-fenced signals.
   */
  constructor(pid: number, private readonly inspector: TreeInspector = createPosixProcessInspector()) {
    const observed = inspector.snapshot()
    const tree = observed.tree(pid)
    if (!tree.some(member => member.pid === pid && observed.alive(member))) {
      throw new Error(`desktop host: cannot identify owned process ${String(pid)}`)
    }
    this.members = tree
  }

  /** Capture descendants before graceful shutdown can reparent them. */
  capture(): void {
    const observed = this.inspector.snapshot()
    const members = new Map<string, ProcessIdentity>()
    for (const member of this.members) {
      if (!observed.alive(member)) continue
      for (const descendant of observed.tree(member.pid)) {
        if (observed.alive(descendant)) members.set(`${String(descendant.pid)}:${descendant.started}`, descendant)
      }
    }
    this.members = [...members.values()]
  }

  /**
   * Kill only observed identities, including descendants in independent process groups.
   * @param timeoutMs - maximum time to observe quiescence after SIGKILL.
   * @returns Resolves after every tracked identity stops; rejects with surviving PIDs on timeout.
   */
  async terminate(timeoutMs: number): Promise<void> {
    const until = performance.now() + timeoutMs
    const failures = new Map<string, unknown>()
    for (;;) {
      this.capture()
      if (this.members.length === 0) return
      for (const member of this.members) {
        try {
          this.inspector.signalProcess(member, 'SIGKILL')
        } catch (error) {
          // Exit races disappear on the next observation; surviving failures retain their cause.
          failures.set(`${String(member.pid)}:${member.started}`, error)
        }
      }
      const remaining = until - performance.now()
      if (remaining <= 0) {
        this.capture()
        if (this.members.length === 0) return
        const identities = this.members.map(member => `${String(member.pid)} (${member.started})`).join(', ')
        throw new AggregateError([...failures.values()], `desktop host: process tree did not stop after ${String(timeoutMs)} ms; surviving processes: ${identities}`)
      }
      await delay(Math.min(25, remaining))
    }
  }
}

/**
 * Await the Utility Process exit notification within the shutdown budget.
 * @param exited - Electron's exit notification for the owned Utility Process.
 * @param timeoutMs - maximum notification wait after termination.
 * @returns Resolves on exit and rejects if Electron never reports completion.
 */
export async function waitForHostExit(exited: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`desktop host: exit was not reported after ${String(timeoutMs)} ms`)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
