/** Version selection and immutable, draft-first publication of Desktop releases. */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from './bump.ts'
import { releaseFamily } from './families.ts'
import { parseChecksums, verifyDesktopAssets, type AssetDigest } from './desktop-artifacts.ts'

/** GitHub repository that owns Desktop installers and updater feeds. */
export const desktopRepository = 'addy777-coder/deepseek-harness'

/** Release fields needed to resume publication without replacing published bytes. */
export interface DesktopRelease {
  id: number
  tag: string
  draft: boolean
  prerelease: boolean
}

/** One asset returned by the GitHub release API. */
export interface ReleaseAsset {
  id: number
  name: string
  /** GitHub leaves open or starter records behind interrupted uploads. */
  state: 'uploaded' | 'open' | 'starter'
}

/** Asset digest and optional UTF-8 contents for checksum and updater files. */
export interface DownloadedAsset extends AssetDigest {
  text?: string
}

/** GitHub operations used by the publication transaction. */
export interface DesktopReleaseStore {
  /**
   * Resolve annotated or lightweight tags.
   * @param tag - Exact Release tag.
   * @returns Its commit, or undefined when the ref is absent.
   */
  tagCommit(tag: string): Promise<string | undefined>
  /**
   * Read a published or draft release.
   * @param tag - Exact Release tag.
   * @returns Release state, or undefined when absent.
   */
  release(tag: string): Promise<DesktopRelease | undefined>
  /**
   * Create a lightweight tag without replacing an existing ref.
   * @param tag - New Release tag.
   * @param commit - Exact source commit.
   */
  createTag(tag: string, commit: string): Promise<void>
  /**
   * Create a draft with generated release notes.
   * @param tag - Release tag already attached to the source commit.
   * @param commit - Exact source commit.
   * @param prerelease - Whether the version has a prerelease identifier.
   * @returns Newly created draft.
   */
  createDraft(tag: string, commit: string, prerelease: boolean): Promise<DesktopRelease>
  /**
   * List every asset across all GitHub response pages.
   * @param release - Owning release.
   * @returns Complete asset inventory.
   */
  assets(release: DesktopRelease): Promise<ReleaseAsset[]>
  /**
   * Hash all downloaded bytes, capturing text for .yml and SHA256SUMS.
   * @param asset - Asset from the owning release's inventory.
   * @returns Digests, byte count, and optional metadata text.
   */
  download(asset: ReleaseAsset): Promise<DownloadedAsset>
  /**
   * Delete an asset owned by a still-draft release.
   * @param asset - Draft asset to replace or remove.
   */
  deleteAsset(asset: ReleaseAsset): Promise<void>
  /**
   * Upload a basename from the verified local asset directory.
   * @param release - Owning draft.
   * @param name - Verified asset basename.
   * @param directory - Directory containing the asset.
   */
  upload(release: DesktopRelease, name: string, directory: string): Promise<void>
  /**
   * Make the verified draft public.
   * @param release - Verified draft.
   * @param latest - GitHub's version/date ordering for stable releases; false for prereleases.
   */
  publish(release: DesktopRelease, latest: 'legacy' | 'false'): Promise<void>
}

/**
 * Require canonical SemVer supported by the repository version bump command.
 * @param version - Manifest or tag version.
 * @returns Whether the version is a prerelease.
 */
export function desktopPrerelease(version: string): boolean {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(version)) {
    throw new Error(`invalid Desktop version: ${version}`)
  }
  const prerelease = version.split('-').slice(1).join('-')
  if (prerelease.split('.').some(field => /^0\d+$/.test(field))) throw new Error(`invalid numeric prerelease identifier: ${version}`)
  return prerelease !== ''
}

function manifestVersion(path: string): string {
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new Error(`${path} must declare a string version`)
  }
  return manifest.version
}

/**
 * Read the unified root, Desktop, published DSH, and private experimental versions.
 * @param root - Repository checkout root.
 * @returns The validated common version.
 */
export function readDesktopVersion(root: string): string {
  const version = manifestVersion(join(root, 'package.json'))
  desktopPrerelease(version)
  const family = releaseFamily('dsh')
  const members = family.members(root)
  family.verifyVersions(members)
  const manifests = [join(root, 'apps/desktop/package.json'), ...members.map(member => join(root, member.directory, 'package.json')),
    ...globSync('packages/experimental/*/package.json', { cwd: root }).map(path => join(root, path))]
  for (const path of manifests) {
    if (manifestVersion(path) !== version) throw new Error(`${path} version must match root version ${version}`)
  }
  return version
}

/**
 * Decide whether a push advanced the version; dispatch explicitly retries its current ref.
 * @param version - Current validated version.
 * @param previous - Version at the push event's before commit; absent for dispatch.
 * @returns True for an increase or explicit dispatch; false for unchanged pushes.
 */
export function shouldBuildDesktop(version: string, previous: string | undefined): boolean {
  desktopPrerelease(version)
  if (previous === undefined) return true
  desktopPrerelease(previous)
  const comparison = compareVersions(version, previous)
  if (comparison < 0) throw new Error(`Desktop version must not decrease: ${previous} -> ${version}`)
  return comparison > 0
}

async function inspectRelease(store: DesktopReleaseStore, version: string, commit: string): Promise<DesktopRelease | undefined> {
  const tag = `v${version}`
  const [tagCommit, release] = await Promise.all([store.tagCommit(tag), store.release(tag)])
  if (tagCommit !== undefined && tagCommit !== commit) throw new Error(`${tag} points to ${tagCommit}, not requested commit ${commit}`)
  if (release !== undefined && tagCommit === undefined) throw new Error(`${tag} release has no corresponding git tag`)
  if (release !== undefined && release.prerelease !== desktopPrerelease(version)) throw new Error(`${tag} has an incorrect prerelease flag`)
  return release
}

/**
 * Download every release asset and verify complete installer, checksum, and updater contents.
 * @param store - GitHub release operations.
 * @param release - Draft or public release to verify.
 * @param version - Expected unified version.
 * @param expected - Optional locally verified hashes for a publication attempt.
 */
export async function verifyRemoteDesktopRelease(
  store: DesktopReleaseStore,
  release: DesktopRelease,
  version: string,
  expected?: ReadonlyMap<string, AssetDigest>,
): Promise<void> {
  const entries = await store.assets(release)
  if (entries.some(asset => asset.state !== 'uploaded')) throw new Error(`${release.tag} contains an incomplete asset upload`)
  const byName = new Map(entries.map(asset => [asset.name, asset]))
  if (byName.size !== entries.length) throw new Error(`${release.tag} contains duplicate asset names`)
  const checksumAsset = byName.get('SHA256SUMS')
  if (checksumAsset === undefined) throw new Error(`${release.tag} is missing SHA256SUMS`)
  const checksum = await store.download(checksumAsset)
  if (checksum.text === undefined) throw new Error('SHA256SUMS download did not include its contents')
  const sums = parseChecksums(checksum.text)
  if (entries.length !== sums.size + 1 || [...sums.keys()].some(name => !byName.has(name))) {
    throw new Error(`${release.tag} assets do not match SHA256SUMS`)
  }
  if (expected !== undefined && (expected.size !== entries.length || expected.get('SHA256SUMS')?.sha256 !== checksum.sha256)) {
    throw new Error(`${release.tag} downloaded SHA256SUMS differs from the verified build`)
  }
  const assets = new Map<string, AssetDigest>()
  const feeds = new Map<string, string>()
  for (const [name, sha256] of sums) {
    const asset = byName.get(name)
    if (asset === undefined) throw new Error(`${release.tag} is missing ${name}`)
    const digest = await store.download(asset)
    if (digest.sha256 !== sha256 || (expected !== undefined && expected.get(name)?.sha256 !== digest.sha256)) {
      throw new Error(`${release.tag} downloaded bytes do not match checksum: ${name}`)
    }
    assets.set(name, digest)
    if (name.endsWith('.yml') && digest.text !== undefined) feeds.set(name, digest.text)
  }
  verifyDesktopAssets(version, assets, feeds)
}

/**
 * Check tag ownership and skip only a fully verified, immutable public release.
 * @param store - Read-only GitHub release operations.
 * @param version - Unified version to release.
 * @param commit - Exact checkout commit.
 * @returns True when a new or resumable draft release needs build artifacts.
 */
export async function needsDesktopBuild(store: DesktopReleaseStore, version: string, commit: string): Promise<boolean> {
  const release = await inspectRelease(store, version, commit)
  if (release === undefined || release.draft) return true
  await verifyRemoteDesktopRelease(store, release, version)
  return false
}

/**
 * Resume only same-commit drafts, verify downloaded bytes, then publish atomically.
 * Published releases are verified and left unchanged, even if rebuilding produces different bytes.
 * @param store - GitHub release operations with publication permission.
 * @param version - Unified version to release.
 * @param commit - Exact checked out commit that must own the tag.
 * @param directory - Locally assembled and verified release directory.
 * @param expected - Digests of the complete local asset set, including SHA256SUMS.
 * @returns Published or already-published status.
 */
export async function publishDesktopRelease(
  store: DesktopReleaseStore,
  version: string,
  commit: string,
  directory: string,
  expected: ReadonlyMap<string, AssetDigest>,
): Promise<'published' | 'already-published'> {
  let release = await inspectRelease(store, version, commit)
  if (release !== undefined && !release.draft) {
    await verifyRemoteDesktopRelease(store, release, version)
    return 'already-published'
  }
  const tag = `v${version}`
  if (await store.tagCommit(tag) === undefined) await store.createTag(tag, commit)
  release ??= await store.createDraft(tag, commit, desktopPrerelease(version))
  const existing = new Map((await store.assets(release)).map(asset => [asset.name, asset]))
  for (const asset of existing.values()) {
    if (!expected.has(asset.name)) await store.deleteAsset(asset)
  }
  for (const [name, digest] of expected) {
    const asset = existing.get(name)
    if (asset !== undefined) {
      if (asset.state === 'uploaded' && (await store.download(asset)).sha256 === digest.sha256) continue
      await store.deleteAsset(asset)
    }
    await store.upload(release, name, directory)
  }
  await verifyRemoteDesktopRelease(store, release, version, expected)
  const confirmed = await inspectRelease(store, version, commit)
  if (confirmed === undefined || !confirmed.draft) throw new Error(`${tag} draft changed during publication`)
  // GitHub's legacy policy orders stable versions when concurrent builds publish out of order.
  await store.publish(confirmed, confirmed.prerelease ? 'false' : 'legacy')
  return 'published'
}
