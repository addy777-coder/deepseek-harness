/** Verify final Desktop containers and load their native runtime under the extracted Electron. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { resolveVpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'
import { withExtractedDesktopInstaller } from './desktop-installer-extraction.ts'
import { isEntry } from './release/process.ts'
import { verifyDesktopPackage } from './verify-desktop-package.ts'

const repository = resolve(import.meta.dirname, '..')

function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(name)))
}

async function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = commandEnvironment()): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let tail = ''
    const collect = (chunk: Buffer): void => { tail = `${tail}${chunk.toString()}`.slice(-8000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise()
      else reject(new Error(`Desktop installer verification command failed (${String(code ?? signal)}): ${command}\n${tail}`))
    })
  })
}

async function sevenZip(): Promise<string> {
  if (process.platform === 'win32' && process.env.ProgramFiles !== undefined) {
    const installed = join(process.env.ProgramFiles, '7-Zip/7z.exe')
    try {
      await access(installed, constants.X_OK)
      return installed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const desktop = createRequire(join(repository, 'apps/desktop/package.json'))
  const builder = createRequire(desktop.resolve('electron-builder'))
  // electron-builder's pinned toolset verifies its download digest and reuses the packaging cache.
  const toolset = builder('app-builder-lib/out/toolsets/7zip.js') as { getPath7za(): Promise<string> }
  return await toolset.getPath7za()
}

/**
 * Extract and verify each final container on its target host, then remove temporary output.
 * @param artifacts - installer and portable paths for the current operating system and CPU.
 * @returns after every container passes resource checks and the real native-runtime smoke.
 */
export async function verifyDesktopInstallers(artifacts: readonly string[]): Promise<void> {
  const target = resolveVpnTarget()
  for (const artifact of artifacts) {
    await withExtractedDesktopInstaller(artifact, target, { sevenZip, run }, async (application) => {
      await verifyDesktopPackage(application)
      const executable = target.platform === 'windows' ? join(application, 'DSH Desktop.exe')
        : target.platform === 'darwin' ? join(application, 'Contents/MacOS/DSH Desktop') : join(application, 'dsh-desktop')
      const resources = target.platform === 'darwin' ? join(application, 'Contents/Resources') : join(application, 'resources')
      await run(executable, [join(repository, 'apps/desktop/tests/native-runtime.smoke.cjs')], application, {
        ...commandEnvironment(),
        ELECTRON_RUN_AS_NODE: '1',
        EXPECTED_NATIVE: `${process.platform}-${target.arch}`,
        DSH_DESKTOP_RUNTIME_DIR: join(resources, 'runtime'),
      })
    })
    console.log(`Desktop installer verified: ${artifact}`)
  }
}

if (isEntry(import.meta.url)) {
  const artifacts = process.argv.slice(2)
  if (artifacts.length === 0) throw new Error('usage: verify-desktop-installers.ts <installer> [<portable-archive> ...]')
  await verifyDesktopInstallers(artifacts)
}
