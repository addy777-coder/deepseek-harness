/** Verify that deployment reuses exactly the registry resolutions of a validated workspace lock. */
import { isDeepStrictEqual } from 'node:util'
import { load } from 'js-yaml'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function registryResolutions(content: string): Map<string, Record<string, unknown>> {
  const parsed: unknown = load(content)
  if (!object(parsed) || !object(parsed.packages)) throw new Error('desktop runtime lock: packages are missing')
  const resolutions = new Map<string, Record<string, unknown>>()
  for (const [identity, entry] of Object.entries(parsed.packages)) {
    if (!object(entry) || !object(entry.resolution)) throw new Error('desktop runtime lock: invalid package resolution')
    const resolution = entry.resolution
    if (resolution.type === 'directory' && typeof resolution.directory === 'string') continue
    if (typeof resolution.integrity !== 'string' || Object.keys(resolution).some(key => key !== 'integrity' && key !== 'tarball')
      || (resolution.tarball !== undefined && typeof resolution.tarball !== 'string')) {
      throw new Error('desktop runtime lock: unsupported package resolution')
    }
    resolutions.set(identity, resolution)
  }
  return resolutions
}

/**
 * Compare every registry package identity and full integrity/URL resolution with the verified source lock.
 * @param verifiedSource - unchanged workspace lock accepted by pnpm's frozen offline install.
 * @param deployed - pnpm's generated deployment lock; workspace directories may be converted to local snapshots.
 * @returns normally only when all registry entries exactly match.
 */
export function verifyDesktopRuntimeLock(verifiedSource: string, deployed: string): void {
  const source = registryResolutions(verifiedSource)
  const target = registryResolutions(deployed)
  if (!isDeepStrictEqual(source, target)) throw new Error('desktop runtime lock: deployed registry resolutions differ from verified source')
}
