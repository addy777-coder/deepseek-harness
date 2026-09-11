/** Validate the native files and executable permissions carried by a Desktop runtime. */
import { chmod, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { VpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'

interface RuntimeAsset { path: string; executable: boolean }

function runtimeResolution(directory: string, specifier: string): string {
  const path = createRequire(join(directory, 'package.json')).resolve(specifier)
  const local = relative(directory, path)
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
    throw new Error(`Desktop runtime resolves ${specifier} outside its packaged directory: ${path}`)
  }
  return path
}

function packageDirectory(directory: string, name: string): string {
  return dirname(runtimeResolution(directory, `${name}/package.json`))
}

async function firstFile(candidates: readonly string[]): Promise<string> {
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Desktop runtime is missing its native asset: ${candidates.join(', ')}`)
}

async function runtimeAssets(directory: string, target: VpnTarget): Promise<RuntimeAsset[]> {
  const platform = target.platform === 'windows' ? 'win32' : target.platform
  const pty = packageDirectory(directory, 'node-pty')
  runtimeResolution(directory, 'koffi')
  runtimeResolution(directory, 'sharp')
  const addonNames = target.platform === 'windows' ? ['conpty.node', 'conpty_console_list.node'] : ['pty.node']
  const assets: RuntimeAsset[] = []
  for (const name of addonNames) {
    const path = await firstFile(['build/Release', 'build/Debug', `prebuilds/${platform}-${target.arch}`]
      .map(location => join(pty, location, name)))
    assets.push({ path, executable: false })
    if (target.platform === 'darwin') assets.push({ path: join(dirname(path), 'spawn-helper'), executable: true })
  }
  const ripgrep = packageDirectory(directory, `@vscode/ripgrep-${platform}-${target.arch}`)
  assets.push({ path: join(ripgrep, 'bin', target.platform === 'windows' ? 'rg.exe' : 'rg'), executable: true })
  if (target.platform === 'linux') {
    const landlock = packageDirectory(directory, `@deepseek-ai/node-addon-landlock-run-linux-${target.arch}`)
    assets.push({ path: join(landlock, 'bin/landlock-run'), executable: true })
  }
  return assets
}

async function verifyAssets(assets: readonly RuntimeAsset[], target: VpnTarget): Promise<void> {
  for (const { path, executable } of assets) {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`Desktop runtime asset is empty or not a file: ${path}`)
    if (process.platform !== 'win32' && target.platform !== 'windows' && executable && (metadata.mode & 0o111) === 0) {
      throw new Error(`Desktop runtime asset is not executable: ${path}`)
    }
  }
}

/**
 * Restore executable permissions after offline deployment and verify native assets.
 * @param directory - materialized runtime closure with its own node_modules.
 * @param target - native platform and architecture selected for this build.
 * @returns after every required native file is present and usable by its file mode.
 */
export async function prepareDesktopRuntimeAssets(directory: string, target: VpnTarget): Promise<void> {
  const assets = await runtimeAssets(directory, target)
  if (process.platform !== 'win32' && target.platform !== 'windows') {
    for (const { path, executable } of assets) {
      if (executable) await chmod(path, (await stat(path)).mode | 0o111)
    }
  }
  await verifyAssets(assets, target)
}

/**
 * Verify packaged native assets without repairing the delivered files.
 * @param directory - runtime directory inside the extracted Desktop application.
 * @param target - expected native platform and architecture.
 * @returns after all required native assets and executable permissions are verified.
 */
export async function verifyDesktopRuntimeAssets(directory: string, target: VpnTarget): Promise<void> {
  await verifyAssets(await runtimeAssets(directory, target), target)
}
