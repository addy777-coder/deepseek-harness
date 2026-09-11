/** Assemble and verify the complete Desktop download set, including updater hashes. */

import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'

/** Native build targets whose installers must all exist before publication. */
export const desktopTargets = ['win-x64', 'mac-arm64', 'mac-x64', 'linux-x64'] as const

/** One supported native Desktop distribution. */
export type DesktopTarget = typeof desktopTargets[number]

/** Digests of the actual bytes, shared by local and downloaded asset validation. */
export interface AssetDigest {
  sha256: string
  sha512: string
  size: number
}

/** A validated electron-updater file entry. */
interface UpdateFile {
  url: string
  sha512: string
  size?: number
}

/** Electron-updater metadata with the legacy primary file retained. */
interface UpdateFeed {
  version: string
  files: UpdateFile[]
  path: string
  sha512: string
  releaseDate?: string
}

/**
 * Name the two installers required from a target.
 * @param version - Unified Desktop version.
 * @param target - Native distribution identifier.
 * @returns Installer basenames in the Release.
 */
export function installerNames(version: string, target: DesktopTarget): string[] {
  const extensions = target === 'win-x64' ? ['exe', 'zip'] : target === 'linux-x64' ? ['AppImage', 'deb'] : ['dmg', 'zip']
  return extensions.map(extension => `DSH-Desktop-${version}-${target}.${extension}`)
}

/**
 * Name the GitHub provider's updater feed for a native target.
 * @param target - Native distribution identifier.
 * @returns Feed basename, shared by the two macOS targets.
 */
export function feedName(target: DesktopTarget): string {
  return target === 'win-x64' ? 'latest.yml' : target === 'linux-x64' ? 'latest-linux.yml' : 'latest-mac.yml'
}

/**
 * Hash a stream without retaining installer bytes in memory.
 * @param chunks - File or HTTP response bytes.
 * @returns SHA-256, SHA-512, and total byte count.
 */
export async function digestBytes(chunks: AsyncIterable<Uint8Array>): Promise<AssetDigest> {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of chunks) {
    sha256.update(chunk)
    sha512.update(chunk)
    size += chunk.byteLength
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size }
}

/**
 * Hash one local artifact.
 * @param path - Absolute artifact path.
 * @returns Digests of its complete bytes.
 */
export async function digestFile(path: string): Promise<AssetDigest> {
  return digestBytes(createReadStream(path))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function parseFeed(source: string, label: string): UpdateFeed {
  const value = record(yaml.load(source, { schema: yaml.JSON_SCHEMA }), label)
  if (typeof value.version !== 'string' || typeof value.path !== 'string' || typeof value.sha512 !== 'string'
    || !Array.isArray(value.files) || value.files.length === 0
    || (value.releaseDate !== undefined && typeof value.releaseDate !== 'string')) {
    throw new Error(`${label} requires version, files, path, and sha512`)
  }
  const files = value.files.map((entry: unknown) => {
    const file = record(entry, `${label} file`)
    if (typeof file.url !== 'string' || typeof file.sha512 !== 'string'
      || (file.size !== undefined && (!Number.isSafeInteger(file.size) || Number(file.size) <= 0))) {
      throw new Error(`${label} has an invalid file entry`)
    }
    return { url: file.url, sha512: file.sha512, ...(file.size === undefined ? {} : { size: Number(file.size) }) }
  })
  return { version: value.version, path: value.path, sha512: value.sha512, files,
    ...(value.releaseDate === undefined ? {} : { releaseDate: value.releaseDate }) }
}

function verifyFeed(feed: UpdateFeed, version: string, targets: readonly DesktopTarget[], assets: ReadonlyMap<string, AssetDigest>): void {
  if (feed.version !== version) throw new Error(`updater version ${feed.version} does not match ${version}`)
  const allowed = new Set(targets.flatMap(target => installerNames(version, target)))
  const seen = new Set<string>()
  for (const file of feed.files) {
    if (!allowed.has(file.url) || seen.has(file.url)) throw new Error(`unexpected or duplicate updater file: ${file.url}`)
    seen.add(file.url)
    const digest = assets.get(file.url)
    if (digest === undefined || digest.sha512 !== file.sha512 || (file.size !== undefined && digest.size !== file.size)) {
      throw new Error(`updater hash or size does not match artifact: ${file.url}`)
    }
  }
  for (const target of targets) {
    const extension = target === 'win-x64' ? 'exe' : target === 'linux-x64' ? 'AppImage' : 'zip'
    const required = `DSH-Desktop-${version}-${target}.${extension}`
    if (!seen.has(required)) throw new Error(`updater feed is missing ${required}`)
  }
  if (!seen.has(feed.path) || assets.get(feed.path)?.sha512 !== feed.sha512) {
    throw new Error(`legacy updater path or hash does not match artifact: ${feed.path}`)
  }
}

/**
 * Require every platform and validate updater references against actual installer hashes.
 * @param version - Expected release version.
 * @param assets - Actual artifact hashes by basename, excluding SHA256SUMS.
 * @param feeds - Updater YAML by basename.
 */
export function verifyDesktopAssets(version: string, assets: ReadonlyMap<string, AssetDigest>, feeds: ReadonlyMap<string, string>): void {
  const required = [...desktopTargets.flatMap(target => installerNames(version, target)), ...new Set(desktopTargets.map(feedName))]
  const optional = new Set(desktopTargets.flatMap(target => installerNames(version, target)).map(name => `${name}.blockmap`))
  for (const name of required) {
    if (!assets.has(name) || assets.get(name)?.size === 0) throw new Error(`release is missing artifact: ${name}`)
  }
  for (const name of assets.keys()) {
    if (!required.includes(name) && !optional.has(name)) throw new Error(`unexpected release artifact: ${name}`)
  }
  for (const name of new Set(desktopTargets.map(feedName))) {
    const source = feeds.get(name)
    if (source === undefined) throw new Error(`release is missing updater feed: ${name}`)
    verifyFeed(parseFeed(source, name), version, desktopTargets.filter(target => feedName(target) === name), assets)
  }
}

/**
 * Parse the release checksum file, rejecting duplicate names and unsafe paths.
 * @param source - SHA256SUMS contents.
 * @returns Expected SHA-256 values keyed by asset basename.
 */
export function parseChecksums(source: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of source.trimEnd().split('\n')) {
    const name = line.slice(66)
    if (!/^[a-f0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/.test(line) || name === 'SHA256SUMS' || sums.has(name)) {
      throw new Error(`invalid or duplicate SHA256SUMS entry: ${line}`)
    }
    sums.set(name, line.slice(0, 64))
  }
  return sums
}

/**
 * Verify an assembled artifact directory after transport between workflow jobs.
 * @param directory - Flat directory containing installers, feeds, and SHA256SUMS.
 * @param version - Expected unified version.
 * @returns Hashes of all verified files, including SHA256SUMS.
 */
export async function readDesktopAssets(directory: string, version: string): Promise<Map<string, AssetDigest>> {
  const sums = parseChecksums(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'))
  const entries = readdirSync(directory, { withFileTypes: true })
  if (entries.length !== sums.size + 1 || entries.some(entry => !entry.isFile() || (entry.name !== 'SHA256SUMS' && !sums.has(entry.name)))) {
    throw new Error('assembled release assets do not match SHA256SUMS')
  }
  const assets = new Map<string, AssetDigest>()
  const feeds = new Map<string, string>()
  for (const [name, sha256] of sums) {
    const digest = await digestFile(join(directory, name))
    if (digest.sha256 !== sha256) throw new Error(`assembled release checksum mismatch: ${name}`)
    assets.set(name, digest)
    if (name.endsWith('.yml')) feeds.set(name, readFileSync(join(directory, name), 'utf8'))
  }
  verifyDesktopAssets(version, assets, feeds)
  assets.set('SHA256SUMS', await digestFile(join(directory, 'SHA256SUMS')))
  return assets
}

/**
 * Combine four private build artifact directories and write verified Release assets.
 * macOS feeds retain both architectures; no target can replace another target's files.
 * @param input - Directory containing one child named for each desktopTargets value.
 * @param output - New directory receiving only publishable assets.
 * @param version - Unified release version.
 * @returns Asset hashes, including the generated SHA256SUMS file.
 */
export async function assembleDesktopAssets(input: string, output: string, version: string): Promise<Map<string, AssetDigest>> {
  mkdirSync(output)
  const assets = new Map<string, AssetDigest>()
  const targetFeeds = new Map<DesktopTarget, UpdateFeed>()
  for (const target of desktopTargets) {
    const directory = join(input, target)
    const names = installerNames(version, target)
    const allowed = new Set([...names, ...names.map(name => `${name}.blockmap`), feedName(target)])
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !allowed.has(entry.name)) throw new Error(`unexpected build artifact: ${target}/${entry.name}`)
    }
    for (const name of names) {
      if (!entries.some(entry => entry.name === name)) throw new Error(`build is missing artifact: ${target}/${name}`)
    }
    for (const entry of entries.filter(entry => entry.name !== feedName(target))) {
      const path = join(directory, entry.name)
      assets.set(entry.name, await digestFile(path))
      copyFileSync(path, join(output, entry.name))
    }
    const feed = parseFeed(readFileSync(join(directory, feedName(target)), 'utf8'), `${target}/${feedName(target)}`)
    verifyFeed(feed, version, [target], assets)
    targetFeeds.set(target, feed)
  }
  const feeds = new Map<string, string>()
  for (const target of ['win-x64', 'mac-x64', 'linux-x64'] as const) {
    const feed = targetFeeds.get(target)
    if (feed === undefined) throw new Error(`missing verified ${target} feed`)
    if (target === 'mac-x64') {
      const arm = targetFeeds.get('mac-arm64')
      if (arm === undefined) throw new Error('missing verified mac-arm64 feed')
      feed.files.push(...arm.files)
    }
    const name = feedName(target)
    const source = yaml.dump(feed, { lineWidth: -1, noRefs: true, sortKeys: false })
    feeds.set(name, source)
    writeFileSync(join(output, name), source)
    assets.set(name, await digestFile(join(output, name)))
  }
  verifyDesktopAssets(version, assets, feeds)
  writeFileSync(join(output, 'SHA256SUMS'), [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest.sha256}  ${name}\n`).join(''))
  assets.set('SHA256SUMS', await digestFile(join(output, 'SHA256SUMS')))
  return assets
}
