import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyVpnArtifact } from '../src/main/vpn-artifact.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function distribution() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-release-'))
  directories.push(directory)
  const assets = []
  for (const path of ['dsh-vpn.exe', 'licenses/GPL-3.0.txt', 'sources/dsh-vpn-corresponding-source.zip']) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), path)
    assets.push({ path, sha256: createHash('sha256').update(path).digest('hex'), size: Buffer.byteLength(path) })
  }
  const manifest = { formatVersion: 1, platform: 'windows', arch: 'x64', binary: 'dsh-vpn.exe', license: 'GPL-3.0-only',
    source: 'sources/dsh-vpn-corresponding-source.zip', assets }
  const save = () => writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await save()
  return { directory, manifest, save }
}

describe('desktop VPN release assets', () => {
  it('verifies the complete source and license distribution during packaging', async () => {
    const { directory, manifest } = await distribution()
    expect(await verifyVpnArtifact(directory, true)).toEqual({ executablePath: join(directory, 'dsh-vpn.exe'), executableSha256: manifest.assets[0]!.sha256 })
  })

  it('rejects missing source, duplicate paths and path traversal', async () => {
    const { directory, manifest, save } = await distribution()
    manifest.source = 'sources/missing.zip'
    await save()
    await expect(verifyVpnArtifact(directory, true)).rejects.toThrow('incomplete')
    manifest.assets.push({ ...manifest.assets[0]! })
    await save()
    await expect(verifyVpnArtifact(directory, true)).rejects.toThrow('asset is invalid')
    manifest.assets.pop()
    manifest.assets[0]!.path = '../outside.exe'
    await save()
    await expect(verifyVpnArtifact(directory, false)).rejects.toThrow('asset is invalid')
  })

  it('rejects modified binaries at launch and modified corresponding sources at packaging', async () => {
    const { directory } = await distribution()
    await writeFile(join(directory, 'sources/dsh-vpn-corresponding-source.zip'), 'corrupt')
    await expect(verifyVpnArtifact(directory, false)).resolves.toHaveProperty('executableSha256')
    await expect(verifyVpnArtifact(directory, true)).rejects.toThrow('integrity')
    await writeFile(join(directory, 'dsh-vpn.exe'), 'corrupt')
    await expect(verifyVpnArtifact(directory, false)).rejects.toThrow('integrity')
  })
})
