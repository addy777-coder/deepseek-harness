/** Load native runtime dependencies under the packaged Electron Node ABI. */
const { createRequire } = require('node:module')
const { join } = require('node:path')

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
console.log(JSON.stringify({
  node: process.versions.node,
  electron: process.versions.electron,
  modules: process.versions.modules,
  nodePty: 'loaded',
  koffi: koffi.version,
  sharp: sharp.versions.sharp,
}))
