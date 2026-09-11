/** Installer completeness, updater integrity, and transport corruption regressions. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleDesktopAssets, parseChecksums, readDesktopAssets } from './desktop-artifacts.ts'
import { writeDesktopFixture } from './desktop-test-fixture.ts'

const roots: string[] = []
const version = '1.2.3-beta.1'

function fixture(): { input: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-artifacts-'))
  roots.push(root)
  const input = join(root, 'input')
  writeDesktopFixture(input, version)
  return { input, output: join(root, 'output') }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

describe('Desktop release artifacts', () => {
  it('merges both macOS architectures and checksums all eight installers and three feeds', async () => {
    const { input, output } = fixture()
    const result = await assembleDesktopAssets(input, output, version)
    const feed = yaml.load(readFileSync(join(output, 'latest-mac.yml'), 'utf8')) as { files: Array<{ url: string }> }
    expect(feed.files.map(file => file.url)).toEqual([
      `DSH-Desktop-${version}-mac-x64.dmg`, `DSH-Desktop-${version}-mac-x64.zip`,
      `DSH-Desktop-${version}-mac-arm64.dmg`, `DSH-Desktop-${version}-mac-arm64.zip`,
    ])
    expect(result.size).toBe(12)
    const sums = parseChecksums(readFileSync(join(output, 'SHA256SUMS'), 'utf8'))
    expect(sums.size).toBe(11)
    expect(await readDesktopAssets(output, version)).toEqual(result)
    expect(readdirSync(output)).toHaveLength(12)
  })

  it.each(['win-x64.exe', 'mac-arm64.dmg', 'mac-x64.zip', 'linux-x64.deb'])('rejects missing %s before publication', async (suffix) => {
    const { input, output } = fixture()
    const target = suffix.split('.')[0]!
    rmSync(join(input, target, `DSH-Desktop-${version}-${suffix}`))
    await expect(assembleDesktopAssets(input, output, version)).rejects.toThrow('missing artifact')
  })

  it('rejects installer bytes that disagree with their updater hash', async () => {
    const { input, output } = fixture()
    writeFileSync(join(input, 'win-x64', `DSH-Desktop-${version}-win-x64.exe`), 'corrupt installer')
    await expect(assembleDesktopAssets(input, output, version)).rejects.toThrow('updater hash or size')
  })

  it('rejects wrong updater versions and absent architecture entries', async () => {
    const first = fixture()
    const feedPath = join(first.input, 'mac-arm64', 'latest-mac.yml')
    writeFileSync(feedPath, readFileSync(feedPath, 'utf8').replace(version, '1.2.4'))
    await expect(assembleDesktopAssets(first.input, first.output, version)).rejects.toThrow('updater version')
    const second = fixture()
    const path = join(second.input, 'mac-arm64', 'latest-mac.yml')
    const feed = yaml.load(readFileSync(path, 'utf8')) as { files: Array<{ url: string }>; path: string; sha512: string }
    feed.files = feed.files.filter(file => file.url.endsWith('.dmg'))
    writeFileSync(path, yaml.dump(feed))
    await expect(assembleDesktopAssets(second.input, second.output, version)).rejects.toThrow('updater feed is missing')
  })

  it('rejects unselected output and corruption after artifact transport', async () => {
    const first = fixture()
    writeFileSync(join(first.input, 'win-x64', 'unexpected.exe'), 'unexpected')
    await expect(assembleDesktopAssets(first.input, first.output, version)).rejects.toThrow('unexpected build artifact')
    const second = fixture()
    await assembleDesktopAssets(second.input, second.output, version)
    writeFileSync(join(second.output, `DSH-Desktop-${version}-linux-x64.AppImage`), 'changed after upload')
    await expect(readDesktopAssets(second.output, version)).rejects.toThrow('checksum mismatch')
  })

  it('retains optional installer blockmaps and hashes their bytes', async () => {
    const { input, output } = fixture()
    const name = `DSH-Desktop-${version}-win-x64.exe.blockmap`
    writeFileSync(join(input, 'win-x64', name), 'blockmap')
    const result = await assembleDesktopAssets(input, output, version)
    expect(result.has(name)).toBe(true)
    expect(await readDesktopAssets(output, version)).toEqual(result)
  })

  it.each(['../outside', 'same\nname', 'SHA256SUMS'])('rejects checksum filename %s', (name) => {
    expect(() => parseChecksums(`${'a'.repeat(64)}  ${name}\n`)).toThrow('invalid or duplicate')
  })

  it('rejects duplicate checksum entries', () => {
    const entry = `${'a'.repeat(64)}  file.zip\n`
    expect(() => parseChecksums(entry.repeat(2))).toThrow('invalid or duplicate')
  })
})
