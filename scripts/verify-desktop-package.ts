/** Verify resources after electron-builder has copied and signed the application. */
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveVpnTarget, verifyVpnArtifact } from '../apps/desktop/src/main/vpn-artifact.ts'
import { verifyDesktopLinuxLauncher } from './desktop-linux-launcher.ts'
import { verifyDesktopRuntimeAssets } from './desktop-runtime-assets.ts'
import { isEntry } from './release/process.ts'

/**
 * Verify an extracted application for this host, including signed VPN bytes.
 * @param directory - Windows/Linux unpacked directory or a macOS .app directory.
 * @returns after executable, VPN, runtime, and bundled package-manager checks pass.
 */
export async function verifyDesktopPackage(directory: string): Promise<void> {
  const target = resolveVpnTarget()
  const resources = join(directory, ...(target.platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']))
  const executable = target.platform === 'windows' ? join(directory, 'DSH Desktop.exe')
    : target.platform === 'darwin' ? join(directory, 'Contents/MacOS/DSH Desktop') : join(directory, 'dsh-desktop')
  const metadata = await stat(executable)
  if (!metadata.isFile() || metadata.size === 0 || (process.platform !== 'win32' && (metadata.mode & 0o111) === 0)) {
    throw new Error(`Desktop application is not executable: ${executable}`)
  }
  await verifyVpnArtifact(join(resources, 'vpn'), true, target)
  await verifyDesktopRuntimeAssets(join(resources, 'runtime'), target)
  if (target.platform === 'linux') await verifyDesktopLinuxLauncher(directory)
  for (const file of ['app.asar', 'app-update.yml', 'pnpm/bin/pnpm.cjs']) {
    if (!(await stat(join(resources, file))).isFile()) throw new Error(`Desktop resource is missing: ${file}`)
  }
}

if (isEntry(import.meta.url)) {
  const directory = process.argv[2]
  if (directory === undefined || process.argv.length !== 3) throw new Error('usage: verify-desktop-package.ts <unpacked-directory-or-app>')
  await verifyDesktopPackage(resolve(directory))
  console.log(`Desktop packaged resources verified: ${directory}`)
}
