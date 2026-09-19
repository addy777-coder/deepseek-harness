/** Instance-local subprocess fixture with separately observable process and tree exit. */
import { PassThrough, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

/** Native helper streams whose stdin EOF and process-tree exit can be held independently. */
export class ScriptedChild implements SubprocessHandle {
  readonly pid = 12345
  readonly control = undefined
  readonly collected = {}
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  readonly completion = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.completion.promise
  readonly tree = Promise.withResolvers<boolean>()
  input = ''
  autoExitOnEof = true
  terminateCalls = 0
  waitForExitCalls = 0

  constructor() {
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => { this.input += chunk.toString(); callback() },
      final: (callback) => { if (this.autoExitOnEof) this.exit(0); callback() },
    })
  }

  /** Send one complete helper event. */
  emit(event: object): void { this.stdout.write(`${JSON.stringify(event)}\n`) }

  /** Settle process close; an unreleased tree still keeps NativeSession.close pending. */
  exit(code: number | null, options: { treeExited?: boolean } = {}): void {
    this.stdout.end()
    this.stderr.end()
    this.completion.resolve({ exitCode: code, signal: code === null ? 'SIGTERM' : null })
    if (options.treeExited !== false) this.releaseTree()
  }

  /** Observe managed tree termination separately from stdin EOF. */
  terminate(): void { this.terminateCalls++; this.exit(null) }

  /** Release the process-tree exit barrier. */
  releaseTree(): void { this.tree.resolve(true) }

  /** Return the complete process-tree lifetime. */
  waitForExit(): Promise<boolean> { this.waitForExitCalls++; return this.tree.promise }
}

/** Subprocess service accepting only scripted pipe children. */
export class ScriptedProcesses extends SubprocessRuntime {
  readonly spawns: SubprocessSpawnSpec[] = []
  readonly children: ScriptedChild[] = []
  onSpawn: ((child: ScriptedChild, spec: SubprocessSpawnSpec) => void) | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      for (const child of this.children) {
        child.exit(0)
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.releaseTree()
      }
      await Promise.allSettled(this.children.map(child => child.done))
    })
  }

  resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }

  terminalEnvironment(): Promise<never> { return Promise.reject(new Error('unexpected terminal environment request')) }

  spawn(spec: SubprocessSpawnSpec): ScriptedChild {
    const child = new ScriptedChild()
    this.spawns.push(spec)
    this.children.push(child)
    queueMicrotask(() => { this.onSpawn?.(child, spec) })
    return child
  }

  spawnTerminal(): Promise<SubprocessTerminalHandle> { return Promise.reject(new Error('unexpected terminal spawn')) }
}
