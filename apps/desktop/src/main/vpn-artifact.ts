/** Verify the independently distributed native VPN executable and its release assets. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Asset { path: string; sha256: string; size: number }

/** Verified executable parameters passed into the desktop profile. */
export interface VpnArtifact {
  /** Absolute executable path outside the Electron archive. */
  readonly executablePath: string
  /** SHA256 pinned by the native distribution manifest. */
  readonly executableSha256: string
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the native release manifest and executable before use.
 * @param directory - unpacked distribution directory.
 * @param allAssets - also hash every license and corresponding-source asset during packaging.
 * @returns the verified executable location and digest; missing or corrupt distributions reject.
 */
export async function verifyVpnArtifact(directory: string, allAssets: boolean): Promise<VpnArtifact> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (!object(manifest) || manifest.formatVersion !== 1 || manifest.platform !== 'windows' || manifest.arch !== 'x64'
    || manifest.binary !== 'dsh-vpn.exe' || manifest.license !== 'GPL-3.0-only'
    || typeof manifest.source !== 'string' || !Array.isArray(manifest.assets)) throw new Error('VPN distribution manifest is invalid')
  const assets: Asset[] = []
  const paths = new Set<string>()
  for (const value of manifest.assets as unknown[]) {
    if (!object(value) || typeof value.path !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(value.path)
      || value.path.split('/').some(part => part === '.' || part === '..')
      || paths.has(value.path.toLowerCase()) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('VPN distribution asset is invalid')
    paths.add(value.path.toLowerCase())
    assets.push({ path: value.path, sha256: value.sha256, size: value.size })
  }
  const binary = assets.find(asset => asset.path === manifest.binary)
  if (!binary || !assets.some(asset => asset.path === manifest.source && asset.path.startsWith('sources/'))
    || !assets.some(asset => asset.path.startsWith('licenses/'))) throw new Error('VPN distribution is incomplete')
  for (const asset of allAssets ? assets : [binary]) {
    const bytes = await readFile(join(directory, asset.path))
    if (bytes.byteLength !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('VPN distribution integrity check failed')
  }
  return { executablePath: join(directory, binary.path), executableSha256: binary.sha256 }
}
