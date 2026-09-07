/** Real Windows selection and cancellation through the installed dialog worker. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Koffi {
  load(path: string): { func(declaration: string): (...args: unknown[]) => unknown }
  proto(declaration: string): unknown
  pointer(type: unknown): unknown
  register(callback: (hwnd: unknown) => number, type: unknown): unknown
  unregister(callback: unknown): void
}

interface Control {
  hwnd: unknown
  id: number
  className: string
}

/**
 * Select a Unicode directory and cancel a second real dialog under Electron's Node ABI.
 * @param executable - Electron or the installed Desktop executable.
 * @param runtime - installed dependency closure containing the built dialog worker.
 * @returns after both workers exit and their temporary workspace is removed.
 */
export async function assertNativeDirectoryPicker(executable: string, runtime: string): Promise<void> {
  const worker = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')
  const koffi = createRequire(worker)('koffi') as Koffi
  const user32 = koffi.load('user32.dll')
  const enumProc = koffi.proto('int __stdcall DshDesktopPickerEnum(void *hwnd, intptr param)')
  const enumThreads = user32.func('int __stdcall EnumThreadWindows(uint32 threadId, void *callback, intptr param)')
  const enumChildren = user32.func('int __stdcall EnumChildWindows(void *hwnd, void *callback, intptr param)')
  const getClass = user32.func('int __stdcall GetClassNameW(void *hwnd, void *buffer, int capacity)')
  const getId = user32.func('int __stdcall GetDlgCtrlID(void *hwnd)')
  const sendText = user32.func('intptr __stdcall SendMessageW(void *hwnd, uint32 message, uintptr wparam, str16 text)')
  const post = user32.func('int __stdcall PostMessageW(void *hwnd, uint32 message, uintptr wparam, intptr lparam)')
  const send = user32.func('intptr __stdcall SendMessageW(void *hwnd, uint32 message, uintptr wparam, intptr lparam)')
  const isVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)')
  const isEnabled = user32.func('int __stdcall IsWindowEnabled(void *hwnd)')

  const controls = (enumerate: (...args: unknown[]) => unknown, owner: unknown): Control[] => {
    const rows: Control[] = []
    const callback = koffi.register((hwnd) => {
      const bytes = Buffer.alloc(512)
      const length = getClass(hwnd, bytes, 256) as number
      rows.push({ hwnd, id: getId(hwnd) as number, className: bytes.toString('utf16le', 0, length * 2) })
      return 1
    }, koffi.pointer(enumProc))
    try {
      enumerate(owner, callback, 0)
    } finally {
      koffi.unregister(callback)
    }
    return rows
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-picker-'))
  try {
    const selected = join(root, '安卓开发-🚀')
    await mkdir(selected)
    for (const expected of [selected, null]) {
      const child = spawn(executable, [worker], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DIALOG_TITLE: 'DSH directory picker regression' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => { resolve({ code, signal }) })
      })
      let failure: Error | undefined
      let result: unknown = undefined
      let stderr = ''
      let poll: ReturnType<typeof setInterval> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      child.once('error', (error) => { failure = error })
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('message', (value) => {
        const message = value as { kind: string; threadId?: number; path?: string | null; message?: string }
        if (message.kind === 'done') result = message.path
        if (message.kind === 'error') failure = new Error(message.message)
        if (message.kind !== 'showing') return
        // Enumerate only the worker's reported thread; the user's windows are never candidates.
        poll = setInterval(() => {
          try {
            const dialog = controls(enumThreads, message.threadId).find(control => control.className === '#32770')
            if (dialog === undefined || !isVisible(dialog.hwnd)) return
            if (expected === null) {
              post(dialog.hwnd, 0x10, 0, 0)
            } else {
              const children = controls(enumChildren, dialog.hwnd)
              const input = children.find(control => control.className === 'Edit' && control.id === 1152)
              const confirm = children.find(control => control.className === 'Button' && control.id === 1)
              if (input === undefined || confirm === undefined || !isVisible(input.hwnd) || !isEnabled(confirm.hwnd)) return
              // The chooser adopts the typed path only while its filename control owns focus.
              send(dialog.hwnd, 0x28, input.hwnd, 1)
              sendText(input.hwnd, 0x0c, 0, expected)
              post(confirm.hwnd, 0x00f5, 0, 0)
            }
            clearInterval(poll)
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error))
            clearInterval(poll)
            child.kill()
          }
        }, 50)
      })
      try {
        const outcome = await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => { reject(new Error('native directory picker did not finish within 60 seconds')) }, 60_000)
          }),
        ])
        if (failure !== undefined) throw failure
        assert.equal(outcome.signal, null, stderr)
        assert.equal(outcome.code, 0, stderr)
        assert.equal(result, expected, 'native directory picker result')
      } finally {
        clearTimeout(deadline)
        clearInterval(poll)
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await closed
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
