/** Build Desktop installers on the operating system and CPU that will run them. */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { resolveVpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { installerNames, type DesktopTarget } from './release/desktop-artifacts.ts'
import { readDesktopVersion } from './release/desktop-release.ts'
import { verifyDesktopInstallers } from './verify-desktop-installers.ts'
import { verifyDesktopPackage } from './verify-desktop-package.ts'

const platform = process.argv[2]
if (process.argv.length !== 3 || !['win32', 'darwin', 'linux'].includes(platform ?? '')) {
  throw new Error('usage: package-desktop.ts <win32|darwin|linux>')
}
if (platform !== process.platform) throw new Error(`Desktop ${platform} installers must be built on ${platform}, not ${process.platform}`)
const target = resolveVpnTarget()
const root = resolve(import.meta.dirname, '..')
const version = readDesktopVersion(root)

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Desktop packaging command failed (${String(result.status ?? result.signal)}): ${command}`)
}

function pnpm(args: readonly string[]): void {
  const invocation = pnpmInvocation(args)
  run(invocation.command, invocation.args)
}

pnpm(['run', 'build:official'])
if (target.platform === 'linux') pnpm(['--dir', 'native/landlock-run', 'run', 'build:native'])
run('pwsh', ['-NoProfile', '-File', 'native/vpn/scripts/build.ps1'])
pnpm(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'stage:runtime'])
pnpm(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'stage:app'])
const targets = {
  windows: ['--win', 'nsis', 'zip'],
  darwin: ['--mac', 'dmg', 'zip'],
  linux: ['--linux', 'AppImage', 'deb'],
}
run(process.execPath, [
  'apps/desktop/node_modules/electron-builder/out/cli/cli.js',
  '--projectDir', '.dsh-build/desktop-app', '--publish', 'never',
  ...targets[target.platform], `--${target.arch}`,
])
const output = join(root, 'apps/desktop/dist-electron')
const appDirectory = target.platform === 'darwin'
  ? join(output, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DSH Desktop.app')
  : join(output, target.platform === 'windows' ? 'win-unpacked' : 'linux-unpacked')
await verifyDesktopPackage(appDirectory)
const releaseTarget: DesktopTarget = target.platform === 'windows' ? 'win-x64'
  : target.platform === 'darwin' ? `mac-${target.arch}` : 'linux-x64'
await verifyDesktopInstallers(installerNames(version, releaseTarget).map(name => join(output, name)))
