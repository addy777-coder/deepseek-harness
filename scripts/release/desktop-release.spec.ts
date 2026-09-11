/** Release selection, resumable drafts, immutable releases, and GitHub response handling. */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleDesktopAssets } from './desktop-artifacts.ts'
import { GitHubDesktopReleases } from './desktop.ts'
import {
  desktopPrerelease, desktopRepository, needsDesktopBuild, publishDesktopRelease, readDesktopVersion, shouldBuildDesktop,
  type DesktopRelease, type DesktopReleaseStore, type DownloadedAsset, type ReleaseAsset,
} from './desktop-release.ts'
import { fixtureDigest, writeDesktopFixture } from './desktop-test-fixture.ts'

const roots: string[] = []
const commit = 'a'.repeat(40)

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-release-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

class MemoryReleaseStore implements DesktopReleaseStore {
  tag: string | undefined
  current: DesktopRelease | undefined
  corruptUpload: string | undefined
  readonly writes: string[] = []
  readonly files = new Map<string, { id: number; bytes: Buffer; state: ReleaseAsset['state'] }>()
  #nextId = 1

  async tagCommit(): Promise<string | undefined> { return this.tag }
  async release(): Promise<DesktopRelease | undefined> { return this.current === undefined ? undefined : { ...this.current } }
  async createTag(_tag: string, sha: string): Promise<void> { this.writes.push('tag'); this.tag = sha }
  async createDraft(tag: string, _sha: string, prerelease: boolean): Promise<DesktopRelease> {
    this.writes.push('draft')
    this.current = { id: 10, tag, draft: true, prerelease }
    return { ...this.current }
  }
  async assets(): Promise<ReleaseAsset[]> { return [...this.files].map(([name, file]) => ({ id: file.id, name, state: file.state })) }
  async download(asset: ReleaseAsset): Promise<DownloadedAsset> {
    const file = this.files.get(asset.name)
    if (file === undefined || file.id !== asset.id) throw new Error(`fixture asset missing: ${asset.name}`)
    if (file.state !== 'uploaded') throw new Error(`fixture cannot download an incomplete upload: ${asset.name}`)
    return { ...fixtureDigest(file.bytes), ...(asset.name.endsWith('.yml') || asset.name === 'SHA256SUMS' ? { text: file.bytes.toString('utf8') } : {}) }
  }
  async deleteAsset(asset: ReleaseAsset): Promise<void> {
    if (this.current?.draft !== true) throw new Error('cannot delete from a public release')
    this.writes.push(`delete:${asset.name}`)
    this.files.delete(asset.name)
  }
  async upload(_release: DesktopRelease, name: string, directory: string): Promise<void> {
    if (this.current?.draft !== true) throw new Error('cannot upload to a public release')
    this.writes.push(`upload:${name}`)
    const bytes = this.corruptUpload === name ? Buffer.from('corrupted upload') : readFileSync(join(directory, name))
    this.files.set(name, { id: this.#nextId++, bytes, state: 'uploaded' })
  }
  async publish(_release: DesktopRelease, latest: 'legacy' | 'false'): Promise<void> {
    this.writes.push(`publish:latest=${latest}`)
    this.current!.draft = false
  }
  seed(directory: string, version: string, draft: boolean): void {
    this.tag = commit
    this.current = { id: 10, tag: `v${version}`, draft, prerelease: desktopPrerelease(version) }
    for (const name of readdirSync(directory)) this.files.set(name, { id: this.#nextId++, bytes: readFileSync(join(directory, name)), state: 'uploaded' })
  }
}

async function fixture(version = '1.2.3'): Promise<{ directory: string; expected: Awaited<ReturnType<typeof assembleDesktopAssets>>; store: MemoryReleaseStore }> {
  const root = tempRoot()
  const input = join(root, 'input')
  const directory = join(root, 'output')
  writeDesktopFixture(input, version)
  const expected = await assembleDesktopAssets(input, directory, version)
  return { directory, expected, store: new MemoryReleaseStore() }
}

describe('Desktop release version selection', () => {
  it('skips unchanged pushes, releases increasing versions, and permits explicit retries', () => {
    expect(shouldBuildDesktop('1.2.3', '1.2.3')).toBe(false)
    expect(shouldBuildDesktop('1.2.4', '1.2.3')).toBe(true)
    expect(shouldBuildDesktop('1.2.4-rc.10', '1.2.4-rc.2')).toBe(true)
    expect(shouldBuildDesktop('1.2.4', '1.2.4-rc.10')).toBe(true)
    expect(shouldBuildDesktop('1.2.3', undefined)).toBe(true)
    expect(() => shouldBuildDesktop('1.2.3', '1.2.4')).toThrow('must not decrease')
  })

  it.each(['1.2.3-alpha.1', '1.2.3-beta.1', '1.2.3-rc.1'])('classifies %s as a prerelease', (version) => {
    expect(desktopPrerelease(version)).toBe(true)
  })

  it.each(['01.2.3', '1.2', '1.2.3-rc.01', '1.2.3-'])('rejects noncanonical version %s', (version) => {
    expect(() => desktopPrerelease(version)).toThrow('invalid')
  })

  it('requires root, Desktop, ordinary and private DSH manifests to share the version', () => {
    const root = tempRoot()
    const manifests = ['package.json', 'apps/desktop/package.json', 'packages/core/example/package.json', 'packages/experimental/private-example/package.json']
    for (const [index, path] of manifests.entries()) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify({ name: index === 0 ? '@deepseek-ai/dsh-root' : `@deepseek-ai/dsh-example-${String(index)}`, version: '1.2.3' }))
    }
    expect(readDesktopVersion(root)).toBe('1.2.3')
    for (const path of manifests) {
      const previous = readFileSync(join(root, path), 'utf8')
      writeFileSync(join(root, path), previous.replace('1.2.3', '1.2.4'))
      expect(() => readDesktopVersion(root)).toThrow(/version/)
      writeFileSync(join(root, path), previous)
    }
  })
})

describe('Desktop publication transaction', () => {
  it('creates the commit tag and draft, uploads all bytes, then publishes Latest', async () => {
    const { directory, expected, store } = await fixture()
    expect(await needsDesktopBuild(store, '1.2.3', commit)).toBe(true)
    expect(await publishDesktopRelease(store, '1.2.3', commit, directory, expected)).toBe('published')
    expect(store.writes.slice(0, 2)).toEqual(['tag', 'draft'])
    expect(store.writes.filter(write => write.startsWith('upload:'))).toHaveLength(12)
    expect(store.writes.at(-1)).toBe('publish:latest=legacy')
    expect(store.current).toMatchObject({ tag: 'v1.2.3', draft: false, prerelease: false })
  })

  it('delegates out-of-order stable publication to GitHub version ordering and excludes prereleases', async () => {
    for (const version of ['2.0.0', '1.2.3']) {
      const stable = await fixture(version)
      await publishDesktopRelease(stable.store, version, commit, stable.directory, stable.expected)
      expect(stable.store.writes.at(-1)).toBe('publish:latest=legacy')
    }
    const pre = await fixture('2.0.1-rc.1')
    await publishDesktopRelease(pre.store, '2.0.1-rc.1', commit, pre.directory, pre.expected)
    expect(pre.store.current?.prerelease).toBe(true)
    expect(pre.store.writes.at(-1)).toBe('publish:latest=false')
  })

  it('refuses a tag on another commit without writes', async () => {
    const { directory, expected, store } = await fixture()
    store.tag = 'b'.repeat(40)
    await expect(needsDesktopBuild(store, '1.2.3', commit)).rejects.toThrow('not requested commit')
    await expect(publishDesktopRelease(store, '1.2.3', commit, directory, expected)).rejects.toThrow('not requested commit')
    expect(store.writes).toEqual([])
  })

  it('verifies a complete existing public release without replacing any bytes', async () => {
    const { directory, expected, store } = await fixture()
    store.seed(directory, '1.2.3', false)
    expect(await needsDesktopBuild(store, '1.2.3', commit)).toBe(false)
    expect(await publishDesktopRelease(store, '1.2.3', commit, directory, expected)).toBe('already-published')
    expect(store.writes).toEqual([])
  })

  it('rejects incomplete or corrupted public releases without repairing their contents', async () => {
    const { directory, expected, store } = await fixture()
    store.seed(directory, '1.2.3', false)
    const name = 'DSH-Desktop-1.2.3-mac-arm64.zip'
    store.files.get(name)!.bytes = Buffer.from('corruption after publication')
    await expect(needsDesktopBuild(store, '1.2.3', commit)).rejects.toThrow('downloaded bytes')
    store.files.delete(name)
    await expect(publishDesktopRelease(store, '1.2.3', commit, directory, expected)).rejects.toThrow('assets do not match')
    expect(store.writes).toEqual([])
  })

  it('leaves failed uploads in a draft and repairs only draft bytes on retry', async () => {
    const { directory, expected, store } = await fixture()
    const name = 'DSH-Desktop-1.2.3-win-x64.exe'
    store.corruptUpload = name
    await expect(publishDesktopRelease(store, '1.2.3', commit, directory, expected)).rejects.toThrow('downloaded bytes')
    expect(store.current?.draft).toBe(true)
    expect(store.writes.some(write => write.startsWith('publish:'))).toBe(false)
    store.corruptUpload = undefined
    const before = store.writes.length
    await publishDesktopRelease(store, '1.2.3', commit, directory, expected)
    expect(store.writes.slice(before)).toEqual([`delete:${name}`, `upload:${name}`, 'publish:latest=legacy'])
  })

  it('refuses a release without its tag or with incorrect prerelease classification', async () => {
    const { directory, store } = await fixture()
    store.seed(directory, '1.2.3', true)
    store.tag = undefined
    await expect(needsDesktopBuild(store, '1.2.3', commit)).rejects.toThrow('no corresponding git tag')
    store.tag = commit
    store.current!.prerelease = true
    await expect(needsDesktopBuild(store, '1.2.3', commit)).rejects.toThrow('incorrect prerelease flag')
  })

  it.each(['open', 'starter'] as const)('replaces an undownloadable %s draft asset and rejects it in a public release', async (state) => {
    const { directory, expected, store } = await fixture()
    const name = 'DSH-Desktop-1.2.3-win-x64.exe'
    store.seed(directory, '1.2.3', true)
    store.files.get(name)!.state = state
    await publishDesktopRelease(store, '1.2.3', commit, directory, expected)
    expect(store.writes).toEqual([`delete:${name}`, `upload:${name}`, 'publish:latest=legacy'])
    store.files.get(name)!.state = state
    const before = [...store.writes]
    await expect(needsDesktopBuild(store, '1.2.3', commit)).rejects.toThrow('incomplete asset upload')
    expect(store.writes).toEqual(before)
  })
})

describe('GitHub Desktop release transport', () => {
  it('does not treat an authorization failure as an absent tag', async () => {
    const github = new GitHubDesktopReleases('fixture-token', async () => new Response('denied', { status: 403 }))
    await expect(github.tagCommit('v1.2.3')).rejects.toThrow('HTTP 403')
  })

  it('resolves annotated tags and scopes requests to the configured repository', async () => {
    const paths: string[] = []
    const github = new GitHubDesktopReleases('fixture-token', async (input) => {
      paths.push(input instanceof Request ? input.url : input.toString())
      return Response.json({ object: paths.length === 1 ? { type: 'tag', sha: 'tag-object' } : { type: 'commit', sha: commit } })
    })
    expect(await github.tagCommit('v1.2.3')).toBe(commit)
    expect(paths).toEqual([
      `https://api.github.com/repos/${desktopRepository}/git/ref/tags/v1.2.3`,
      `https://api.github.com/repos/${desktopRepository}/git/tags/tag-object`,
    ])
  })

  it('reads all pages of assets and hashes streamed response bytes', async () => {
    const github = new GitHubDesktopReleases('fixture-token', async (input, options) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/assets?')) {
        const offset = url.endsWith('page=1') ? 0 : 100
        return Response.json(Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) => ({ id: offset + index + 1, name: `file-${String(offset + index)}.zip`, state: 'uploaded' })))
      }
      expect(new Headers(options?.headers).get('Accept')).toBe('application/octet-stream')
      return new Response('downloaded installer bytes')
    })
    expect(await github.assets({ id: 1, tag: 'v1.2.3', draft: true, prerelease: false })).toHaveLength(101)
    expect(await github.download({ id: 1, name: 'installer.zip', state: 'uploaded' })).toEqual(fixtureDigest(Buffer.from('downloaded installer bytes')))
  })

  it('sends draft, uploaded bytes, and explicit Latest decisions through the GitHub API', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'installer.zip'), 'local installer bytes')
    const requests: Array<{ url: string; method: string; body: string }> = []
    const github = new GitHubDesktopReleases('fixture-token', async (input, options) => {
      const url = input instanceof Request ? input.url : input.toString()
      const body = options?.body instanceof Blob ? await options.body.text() : typeof options?.body === 'string' ? options.body : ''
      requests.push({ url, method: options?.method ?? 'GET', body })
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-token')
      return Response.json({ id: 10, tag_name: 'v1.2.3', draft: options?.method !== 'PATCH', prerelease: false })
    })
    await github.createTag('v1.2.3', commit)
    const draft = await github.createDraft('v1.2.3', commit, false)
    await github.upload(draft, 'installer.zip', root)
    await github.publish(draft, 'legacy')
    expect(JSON.parse(requests[0]!.body)).toEqual({ ref: 'refs/tags/v1.2.3', sha: commit })
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ draft: true, generate_release_notes: true, make_latest: 'false', target_commitish: commit })
    expect(requests[2]).toEqual({
      url: `https://uploads.github.com/repos/${desktopRepository}/releases/10/assets?name=installer.zip`,
      method: 'POST', body: 'local installer bytes',
    })
    expect(JSON.parse(requests[3]!.body)).toEqual({ draft: false, make_latest: 'legacy' })
  })

  it('finds a same-tag draft when the tag endpoint omits it', async () => {
    const github = new GitHubDesktopReleases('fixture-token', async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/releases/tags/')) return new Response('missing', { status: 404 })
      return Response.json([
        { id: 1, tag_name: 'v1.2.3', draft: true, prerelease: false },
        { id: 2, tag_name: 'v1.2.2', draft: false, prerelease: false },
      ])
    })
    expect(await github.release('v1.2.3')).toEqual({ id: 1, tag: 'v1.2.3', draft: true, prerelease: false })
  })
})
