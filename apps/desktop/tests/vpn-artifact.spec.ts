import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVpnTarget, verifyVpnArtifact, type VpnTarget } from '../src/main/vpn-artifact.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const windows = resolveVpnTarget('win32', 'x64')
const targets = [windows, resolveVpnTarget('darwin', 'arm64'), resolveVpnTarget('darwin', 'x64'), resolveVpnTarget('linux', 'x64')]

async function distribution(target: VpnTarget = windows) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-release-'))
  directories.push(directory)
  const assets = []
  for (const path of [target.binary, 'licenses/GPL-3.0.txt', 'sources/dsh-vpn-corresponding-source.zip']) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), path, { mode: path === target.binary ? 0o755 : 0o644 })
    assets.push({ path, sha256: createHash('sha256').update(path).digest('hex'), size: Buffer.byteLength(path) })
  }
  const manifest = { formatVersion: 1, platform: target.platform as string, arch: target.arch as string, binary: target.binary as string, license: 'GPL-3.0-only',
    source: 'sources/dsh-vpn-corresponding-source.zip', assets }
  const save = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await save()
  return { directory, manifest, save }
}

describe('desktop VPN release assets', () => {
  it.each(targets)('verifies the complete $directory distribution during packaging', async (target) => {
    const { directory, manifest } = await distribution(target)
    expect(await verifyVpnArtifact(directory, true, target)).toEqual({
      executablePath: join(directory, target.binary), executableSha256: manifest.assets[0]!.sha256,
    })
  })

  it.each([['win32', 'arm64'], ['linux', 'arm64'], ['freebsd', 'x64']])('rejects unsupported %s-%s hosts', (platform, arch) => {
    expect(() => resolveVpnTarget(platform, arch)).toThrow('Desktop does not support')
  })

  it.each(['platform', 'arch', 'binary'] as const)('rejects a mismatched manifest %s', async (key) => {
    const { directory, manifest, save } = await distribution()
    manifest[key] = 'wrong-target'
    await save()
    await expect(verifyVpnArtifact(directory, true, windows)).rejects.toThrow('manifest is invalid')
  })

  it('rejects missing source, duplicate paths and path traversal', async () => {
    const { directory, manifest, save } = await distribution()
    manifest.source = 'sources/missing.zip'
    await save()
    await expect(verifyVpnArtifact(directory, true, windows)).rejects.toThrow('incomplete')
    manifest.assets.push({ ...manifest.assets[0]! })
    await save()
    await expect(verifyVpnArtifact(directory, true, windows)).rejects.toThrow('asset is invalid')
    manifest.assets.pop()
    manifest.assets[0]!.path = '../outside.exe'
    await save()
    await expect(verifyVpnArtifact(directory, false, windows)).rejects.toThrow('asset is invalid')
  })

  it('rejects modified binaries at launch and modified corresponding sources at packaging', async () => {
    const { directory } = await distribution()
    await writeFile(join(directory, 'sources/dsh-vpn-corresponding-source.zip'), 'corrupt')
    await expect(verifyVpnArtifact(directory, false, windows)).resolves.toHaveProperty('executableSha256')
    await expect(verifyVpnArtifact(directory, true, windows)).rejects.toThrow('integrity')
    await writeFile(join(directory, 'dsh-vpn.exe'), 'corrupt')
    await expect(verifyVpnArtifact(directory, false, windows)).rejects.toThrow('integrity')
  })

  it.skipIf(process.platform === 'win32')('rejects a POSIX distribution whose executable bit was lost', async () => {
    const target = resolveVpnTarget('darwin', 'arm64')
    const { directory } = await distribution(target)
    await chmod(join(directory, target.binary), 0o644)
    await expect(verifyVpnArtifact(directory, true, target)).rejects.toThrow('not executable')
  })
})
