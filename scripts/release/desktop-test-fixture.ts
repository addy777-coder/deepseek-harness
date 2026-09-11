/** Small installer bytes and real updater/checksum encodings for release regressions. */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { desktopTargets, feedName, installerNames, type AssetDigest } from './desktop-artifacts.ts'

/**
 * Hash a small fixture body using the same published algorithms.
 * @param bytes - Complete fixture bytes.
 * @returns Expected SHA-256, SHA-512, and size.
 */
export function fixtureDigest(bytes: Uint8Array): AssetDigest {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.byteLength }
}

/**
 * Write four isolated native job outputs with hash-valid updater metadata.
 * @param root - New input directory underneath the caller's private temporary root.
 * @param version - Release version represented by the fixtures.
 */
export function writeDesktopFixture(root: string, version: string): void {
  mkdirSync(root)
  for (const target of desktopTargets) {
    const directory = join(root, target)
    mkdirSync(directory)
    const files = installerNames(version, target).map((name) => {
      const bytes = Buffer.from(`installer ${name}\n`)
      writeFileSync(join(directory, name), bytes)
      return { url: name, sha512: fixtureDigest(bytes).sha512, size: bytes.byteLength }
    })
    const primary = target.startsWith('mac-') ? files[1] : files[0]
    if (primary === undefined) throw new Error(`fixture ${target} has no primary installer`)
    writeFileSync(join(directory, feedName(target)), yaml.dump({ version, files, path: primary.url, sha512: primary.sha512, releaseDate: '2026-09-11T00:00:00.000Z' }))
  }
}
