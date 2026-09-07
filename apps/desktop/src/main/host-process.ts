/** Lifecycle owner for the `dsh --profile desktop` Electron Utility Process. */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, MessageChannelMain, type BrowserWindow, utilityProcess, type UtilityProcess } from 'electron'
import type {
  DesktopHostControlFrame,
  DesktopHostStartupPhase,
  DesktopWindowId,
} from '@deepseek-ai/dsh-desktop-transport'
import { parseDesktopHostLifecycleFrame } from '@deepseek-ai/dsh-desktop-transport'
import { channels } from './channels.ts'
import { waitForHostReadiness } from './host-startup.ts'

const HOST_STOP_TIMEOUT_MS = 5_000

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

function sourceRoot(): string {
  return resolve(app.getAppPath(), '..', '..')
}

function dshEntry(): string | undefined {
  const staged = process.env.DSH_DESKTOP_RUNTIME_DIR
  if (!app.isPackaged && staged !== undefined) {
    return join(resolve(staged), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : undefined
}

function hostEntry(): string {
  return join(app.getAppPath(), 'lib', 'host-bootstrap.js')
}

async function terminateUtilityProcess(child: UtilityProcess): Promise<void> {
  if (process.platform !== 'win32') {
    child.kill()
    return
  }
  await new Promise<void>((resolvePromise) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => { child.kill(); resolvePromise() })
    killer.once('exit', (code) => { if (code !== 0) child.kill(); resolvePromise() })
  })
}

/** Owns exactly one Host process and proves its stop before replacement. */
export class DesktopHostProcess {
  private child: UtilityProcess | undefined
  private exitState: Deferred<void> | undefined
  private expectedExit = false
  private stderrTail: string[] = []

  /** @param onUnexpectedExit - reports a Host that exited outside an owned stop. */
  constructor(private readonly onUnexpectedExit: (message: string) => void) {}

  /** Start a fresh Host and await its Loader readiness frame. */
  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error('desktop host: a process is already owned')
    const ready = deferred<void>()
    const exited = deferred<void>()
    this.exitState = exited
    this.expectedExit = false
    this.stderrTail = []
    let startupPhase: DesktopHostStartupPhase = 'bootstrap'
    const runtimeEntry = dshEntry()
    const child = utilityProcess.fork(hostEntry(), ['--profile', 'desktop'], {
      cwd: homedir(),
      env: {
        ...process.env,
        DSH_DESKTOP_DSH_ENTRY: runtimeEntry ?? '',
        DSH_HOME: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
        ...(runtimeEntry !== undefined
          ? {}
          : { TSX_TSCONFIG_PATH: join(sourceRoot(), 'tsconfig.base.json') }),
      },
      execArgv: ['--expose-internals'],
      serviceName: 'DSH Desktop Host',
      stdio: 'pipe',
    })
    this.child = child
    child.on('message', (message: unknown) => {
      let frame
      try {
        frame = parseDesktopHostLifecycleFrame(message)
      } catch (error) {
        ready.reject(error)
        return
      }
      if (frame.t === 'startup') {
        startupPhase = frame.phase
        return
      }
      if (frame.t === 'ready') ready.resolve()
      if (frame.t === 'stopped') this.expectedExit = true
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail.push(String(chunk))
      if (this.stderrTail.length > 80) this.stderrTail.splice(0, this.stderrTail.length - 80)
    })
    child.stdout?.on('data', (chunk: Buffer | string) => { process.stdout.write(chunk) })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = undefined
      const message = `DSH Host exited with code ${String(code)}${this.stderrTail.length === 0 ? '' : `\n${this.stderrTail.join('').trim()}`}`
      ready.reject(new Error(message))
      exited.resolve()
      if (!this.expectedExit) this.onUnexpectedExit(message)
    })
    try {
      await waitForHostReadiness(ready.promise, () => ({
        phase: startupPhase,
        stderrTail: this.stderrTail,
      }))
    } catch (error) {
      if (this.child === child) {
        this.expectedExit = true
        await terminateUtilityProcess(child)
        await exited.promise
        this.exitState = undefined
      }
      throw error
    }
  }

  /** Transfer a direct Renderer/Host MessagePort pair. */
  attach(window: BrowserWindow, windowId: DesktopWindowId): void {
    const child = this.child
    if (child === undefined) throw new Error('desktop host: no ready process')
    const { port1, port2 } = new MessageChannelMain()
    const frame: DesktopHostControlFrame = { v: 1, t: 'attach', windowId }
    child.postMessage(frame, [port1])
    window.webContents.postMessage(channels.hostPort, { windowId }, [port2])
  }

  /** Gracefully stop the Host, forcing termination only after the shared five-second bound. */
  async stop(): Promise<void> {
    const child = this.child
    const exited = this.exitState
    if (child === undefined || exited === undefined) return
    this.expectedExit = true
    const frame: DesktopHostControlFrame = { v: 1, t: 'shutdown' }
    child.postMessage(frame)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        exited.promise,
        new Promise<void>((resolvePromise) => {
          timer = setTimeout(resolvePromise, HOST_STOP_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (this.child === child) await terminateUtilityProcess(child)
    await exited.promise
    this.exitState = undefined
  }

  /** Replace the Host only after its predecessor reaches quiescence. */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }
}
