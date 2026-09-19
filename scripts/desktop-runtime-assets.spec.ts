import { chmod, mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVpnTarget, type VpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'
import { prepareDesktopRuntimeAssets, verifyDesktopRuntimeAssets } from './desktop-runtime-assets.ts'

const roots: string[] = []
const targets = [resolveVpnTarget('win32', 'x64'), resolveVpnTarget('darwin', 'arm64'), resolveVpnTarget('darwin', 'x64'), resolveVpnTarget('linux', 'x64')]
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function write(path: string, content = 'native-fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { mode: 0o755 })
}

async function fixture(target: VpnTarget) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
  roots.push(root)
  const platform = target.platform === 'windows' ? 'win32' : target.platform
  const packages = ['node-pty', 'koffi', 'sharp', `@vscode/ripgrep-${platform}-${target.arch}`]
  if (target.platform === 'linux') packages.push(`@deepseek-ai/node-addon-landlock-run-linux-${target.arch}`)
  await write(join(root, 'package.json'), '{}')
  for (const name of packages) {
    await write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({
      name, ...(name === 'koffi' || name === 'sharp' ? { exports: { '.': './index.js' } } : {}),
    }))
    await write(join(root, 'node_modules', name, 'index.js'), '')
  }
  const pty = join(root, 'node_modules/node-pty/prebuilds', `${platform}-${target.arch}`)
  const addons = target.platform === 'windows' ? ['conpty.node', 'conpty_console_list.node'] : ['pty.node']
  for (const addon of addons) await write(join(pty, addon))
  if (target.platform === 'darwin') await write(join(pty, 'spawn-helper'))
  const ripgrep = join(root, 'node_modules/@vscode', `ripgrep-${platform}-${target.arch}`, 'bin', target.platform === 'windows' ? 'rg.exe' : 'rg')
  await write(ripgrep)
  const landlock = join(root, 'node_modules/@deepseek-ai', `node-addon-landlock-run-linux-${target.arch}`, 'bin/landlock-run')
  if (target.platform === 'linux') await write(landlock)
  return { root, pty, ripgrep, landlock }
}

describe('Desktop packaged native assets', () => {
  it.each(targets)('accepts a complete $directory runtime', async (target) => {
    const { root } = await fixture(target)
    await expect(verifyDesktopRuntimeAssets(root, target)).resolves.toBeUndefined()
  })

  it('accepts a runtime reached through a filesystem alias', async () => {
    const target = resolveVpnTarget('darwin', 'arm64')
    const { root } = await fixture(target)
    const parent = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-alias-'))
    roots.push(parent)
    const alias = join(parent, 'runtime')
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(verifyDesktopRuntimeAssets(alias, target)).resolves.toBeUndefined()
    } finally {
      await unlink(alias)
    }
  })

  it.each(targets)('rejects a missing $directory node-pty addon', async (target) => {
    const { root, pty } = await fixture(target)
    await rm(join(pty, target.platform === 'windows' ? 'conpty_console_list.node' : 'pty.node'))
    await expect(verifyDesktopRuntimeAssets(root, target)).rejects.toThrow('missing its native asset')
  })

  it('requires the built Linux Landlock launcher', async () => {
    const target = resolveVpnTarget('linux', 'x64')
    const { root, landlock } = await fixture(target)
    await rm(landlock)
    await expect(verifyDesktopRuntimeAssets(root, target)).rejects.toThrow('landlock-run')
  })

  it('refuses to resolve dependencies outside the packaged runtime', async () => {
    const target = resolveVpnTarget('win32', 'x64')
    const { root } = await fixture(target)
    const nested = join(root, 'incomplete-runtime')
    await write(join(nested, 'package.json'), '{}')
    await expect(verifyDesktopRuntimeAssets(nested, target)).rejects.toThrow('outside its packaged directory')
  })

  it.skipIf(process.platform === 'win32')('repairs the macOS helper during staging and detects lost permissions in the package', async () => {
    const target = resolveVpnTarget('darwin', 'arm64')
    const { root, pty, ripgrep } = await fixture(target)
    const helper = join(pty, 'spawn-helper')
    await chmod(helper, 0o644)
    await expect(verifyDesktopRuntimeAssets(root, target)).rejects.toThrow('not executable')
    await prepareDesktopRuntimeAssets(root, target)
    expect((await stat(helper)).mode & 0o111).not.toBe(0)
    await chmod(ripgrep, 0o644)
    await expect(verifyDesktopRuntimeAssets(root, target)).rejects.toThrow('not executable')
  })
})
