/** GitHub Actions entry for version-gated Desktop builds and verified release publication. */

import { appendFileSync, openAsBlob, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { assembleDesktopAssets, digestBytes, readDesktopAssets } from './desktop-artifacts.ts'
import {
  desktopRepository, needsDesktopBuild, publishDesktopRelease, readDesktopVersion, shouldBuildDesktop,
  type DesktopRelease, type DesktopReleaseStore, type DownloadedAsset, type ReleaseAsset,
} from './desktop-release.ts'
import { capture, isEntry } from './process.ts'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('GitHub must return a positive numeric id')
  return value
}

function releaseFromJson(value: unknown): DesktopRelease {
  const release = object(value, 'GitHub release')
  if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('GitHub release must declare draft and prerelease')
  return { id: id(release.id), tag: string(release.tag_name, 'GitHub release tag'), draft: release.draft, prerelease: release.prerelease }
}

/** GitHub REST implementation; only explicit 404 responses mean an absent release or tag. */
export class GitHubDesktopReleases implements DesktopReleaseStore {
  readonly #token: string
  readonly #fetch: typeof fetch

  /**
   * Bind the current workflow token to the fixed Desktop release repository.
   * @param token - github.token with read or publication permission.
   * @param fetcher - HTTP implementation; tests may inject an instance-local adapter.
   */
  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.#token = token
    this.#fetch = fetcher
  }

  async #response(path: string, options: RequestInit = {}, missing = false, uploads = false): Promise<Response | undefined> {
    const headers = new Headers({
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    for (const [name, value] of new Headers(options.headers)) headers.set(name, value)
    const response = await this.#fetch(`https://${uploads ? 'uploads' : 'api'}.github.com/repos/${desktopRepository}/${path}`, {
      ...options,
      headers,
    })
    if (missing && response.status === 404) return undefined
    if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${path} failed: HTTP ${String(response.status)} ${await response.text()}`)
    return response
  }

  async #json(path: string, options: RequestInit = {}, missing = false): Promise<unknown> {
    const response = await this.#response(path, options, missing)
    return response === undefined ? undefined : response.json()
  }

  async #list(path: string): Promise<unknown[]> {
    const all: unknown[] = []
    for (let page = 1; ; page += 1) {
      const batch = await this.#json(`${path}?per_page=100&page=${String(page)}`)
      if (!Array.isArray(batch)) throw new Error(`GitHub ${path} must return an array`)
      const entries: unknown[] = batch
      all.push(...entries)
      if (batch.length < 100) return all
    }
  }

  async tagCommit(tag: string): Promise<string | undefined> {
    const ref = await this.#json(`git/ref/tags/${encodeURIComponent(tag)}`, {}, true)
    if (ref === undefined) return undefined
    let target = object(object(ref, 'GitHub ref').object, 'GitHub ref object')
    for (let depth = 0; depth < 16; depth += 1) {
      if (target.type === 'commit') return string(target.sha, 'GitHub tag commit')
      if (target.type !== 'tag') throw new Error(`${tag} must reference a commit or annotated tag`)
      const annotated = await this.#json(`git/tags/${encodeURIComponent(string(target.sha, 'GitHub annotated tag SHA'))}`)
      target = object(object(annotated, 'GitHub annotated tag').object, 'GitHub tag object')
    }
    throw new Error(`${tag} has too many nested annotated tags`)
  }

  async release(tag: string): Promise<DesktopRelease | undefined> {
    const found = await this.#json(`releases/tags/${encodeURIComponent(tag)}`, {}, true)
    if (found !== undefined) return releaseFromJson(found)
    const drafts = (await this.#list('releases')).map(releaseFromJson).filter(release => release.tag === tag)
    if (drafts.length > 1) throw new Error(`${tag} has duplicate releases`)
    return drafts[0]
  }

  async createTag(tag: string, commit: string): Promise<void> {
    await this.#json('git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit }) })
  }

  async createDraft(tag: string, commit: string, prerelease: boolean): Promise<DesktopRelease> {
    return releaseFromJson(await this.#json('releases', { method: 'POST', body: JSON.stringify({
      tag_name: tag, target_commitish: commit, name: `DSH Desktop ${tag.slice(1)}`, draft: true, prerelease,
      generate_release_notes: true, make_latest: 'false',
    }) }))
  }

  async assets(release: DesktopRelease): Promise<ReleaseAsset[]> {
    return (await this.#list(`releases/${String(release.id)}/assets`)).map((value) => {
      const asset = object(value, 'GitHub asset')
      const state = string(asset.state, 'GitHub asset state')
      if (state !== 'uploaded' && state !== 'open' && state !== 'starter') throw new Error(`unsupported GitHub asset state: ${state}`)
      return { id: id(asset.id), name: string(asset.name, 'GitHub asset name'), state }
    })
  }

  async download(asset: ReleaseAsset): Promise<DownloadedAsset> {
    const response = await this.#response(`releases/assets/${String(asset.id)}`, { headers: { Accept: 'application/octet-stream' } })
    const body = response?.body
    if (body === null || body === undefined) throw new Error(`GitHub returned no asset body: ${asset.name}`)
    const captureText = asset.name === 'SHA256SUMS' || asset.name.endsWith('.yml')
    const textChunks: Uint8Array[] = []
    let textSize = 0
    async function* chunks(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
      for await (const chunk of source) {
        if (captureText) {
          textSize += chunk.byteLength
          if (textSize > 1_048_576) throw new Error(`release metadata exceeds 1 MiB: ${asset.name}`)
          textChunks.push(chunk)
        }
        yield chunk
      }
    }
    const digest = await digestBytes(chunks(body))
    return { ...digest, ...(captureText ? { text: Buffer.concat(textChunks).toString('utf8') } : {}) }
  }

  async deleteAsset(asset: ReleaseAsset): Promise<void> {
    await this.#response(`releases/assets/${String(asset.id)}`, { method: 'DELETE' })
  }

  async upload(release: DesktopRelease, name: string, directory: string): Promise<void> {
    const body = await openAsBlob(join(directory, name))
    await this.#response(`releases/${String(release.id)}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.size) }, body,
    }, false, true)
  }

  async publish(release: DesktopRelease, latest: 'legacy' | 'false'): Promise<void> {
    const published = releaseFromJson(await this.#json(`releases/${String(release.id)}`, {
      method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: latest }),
    }))
    if (published.draft || published.tag !== release.tag || published.prerelease !== release.prerelease) {
      throw new Error(`GitHub did not publish ${release.tag} with the expected classification`)
    }
  }
}

function requiredEnvironment(name: string): string {
  return string(process.env[name], name)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } }, allowPositionals: true })
  const [command] = positionals
  if (positionals.length !== 1 || !['prepare', 'assemble', 'publish'].includes(command ?? '')) {
    throw new Error('usage: desktop.ts <prepare|assemble|publish> [--input <build-artifacts>] [--output <release-assets>]')
  }
  const root = process.cwd()
  const version = readDesktopVersion(root)
  const commit = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  if (command === 'assemble') {
    await assembleDesktopAssets(resolve(string(values.input, '--input')), resolve(string(values.output, '--output')), version)
    console.log(`Desktop ${version}: four native targets and updater feeds verified`)
    return
  }
  if (requiredEnvironment('GITHUB_REPOSITORY') !== desktopRepository) throw new Error(`Desktop releases belong to ${desktopRepository}`)
  if (commit !== requiredEnvironment('GITHUB_SHA')) throw new Error('Desktop checkout does not match GITHUB_SHA')
  const store = new GitHubDesktopReleases(requiredEnvironment('GH_TOKEN'))
  if (command === 'prepare') {
    const eventName = requiredEnvironment('GITHUB_EVENT_NAME')
    let previous: string | undefined
    if (eventName === 'push') {
      const event = object(JSON.parse(readFileSync(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8')), 'push event')
      const before = string(event.before, 'push before commit')
      if (!/^[a-f0-9]{40,64}$/.test(before) || /^0+$/.test(before)) throw new Error('push has no version baseline; use workflow_dispatch for the first Desktop release')
      const manifest = object(JSON.parse(capture('git', ['show', `${before}:package.json`], { cwd: root })), 'previous root manifest')
      previous = string(manifest.version, 'previous root version')
    } else if (eventName !== 'workflow_dispatch') {
      throw new Error(`unsupported Desktop release event: ${eventName}`)
    }
    const build = shouldBuildDesktop(version, previous) && await needsDesktopBuild(store, version, commit)
    appendFileSync(requiredEnvironment('GITHUB_OUTPUT'), `version=${version}\ncommit=${commit}\nbuild=${String(build)}\n`)
    console.log(`Desktop ${version}: ${build ? 'build required' : 'unchanged version or verified existing release'}`)
    return
  }
  const directory = resolve(string(values.input, '--input'))
  const expected = await readDesktopAssets(directory, version)
  const result = await publishDesktopRelease(store, version, commit, directory, expected)
  console.log(`Desktop ${version}: ${result}; https://github.com/${desktopRepository}/releases/tag/v${version}`)
}

if (isEntry(import.meta.url)) await main()
