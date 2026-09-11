/** Load native runtime dependencies under the packaged Electron Node ABI. */
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const expectedNative = process.env.EXPECTED_NATIVE
const actualNative = `${process.platform}-${process.arch}`
if (expectedNative !== undefined && expectedNative !== actualNative) {
  throw new Error(`Desktop native runtime target mismatch: expected ${expectedNative}, received ${actualNative}`)
}

const runtime = process.env.DSH_DESKTOP_RUNTIME_DIR
if (runtime === undefined || runtime === '') {
  throw new Error('DSH_DESKTOP_RUNTIME_DIR is required')
}
const runtimeRequire = createRequire(join(runtime, 'package.json'))
const pty = runtimeRequire('node-pty')
const koffi = runtimeRequire('koffi')
const sharp = runtimeRequire('sharp')

if (typeof pty.spawn !== 'function' || typeof koffi.version !== 'string' || typeof sharp.versions?.sharp !== 'string') {
  throw new Error('desktop native runtime exports are incomplete')
}

async function main() {
  const marker = 'dsh-native-runtime-ok'
  const windows = process.platform === 'win32'
  const command = windows ? process.env.ComSpec : '/bin/sh'
  if (!command) throw new Error('ComSpec is required for the Windows native runtime smoke')
  const args = windows ? ['/d', '/c', `echo ${marker}`] : ['-c', `printf '%s\\n' '${marker}'`]
  const env = { PATH: process.env.PATH ?? '', TERM: 'xterm' }
  if (windows) {
    env.SystemRoot = process.env.SystemRoot
    env.WINDIR = process.env.WINDIR
  }
  const terminal = pty.spawn(command, args, { cwd: tmpdir(), env, cols: 80, rows: 24 })
  let output = ''
  let timedOut = false
  let killed = false
  const kill = () => {
    if (killed) return
    killed = true
    terminal.kill()
  }
  const data = terminal.onData(chunk => { output += chunk })
  let exited
  let timer
  try {
    const exit = await new Promise((resolve, reject) => {
      exited = terminal.onExit(resolve)
      timer = setTimeout(() => {
        timedOut = true
        try { kill() } catch (error) { reject(error) }
      }, 30_000)
    })
    if (timedOut) throw new Error('Desktop native PTY did not exit before its deadline')
    if (exit.exitCode !== 0 || exit.signal || !output.includes(marker)) {
      throw new Error(`Desktop native PTY failed: ${JSON.stringify({ exit, output })}`)
    }
  } finally {
    clearTimeout(timer)
    // Windows retains the ConPTY host and worker after the shell exits.
    if (windows) kill()
    data.dispose()
    exited?.dispose()
  }
  await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
  console.log(JSON.stringify({
    node: process.versions.node,
    electron: process.versions.electron,
    modules: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    nodePty: 'spawned and exited',
    koffi: koffi.version,
    sharp: sharp.versions.sharp,
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
