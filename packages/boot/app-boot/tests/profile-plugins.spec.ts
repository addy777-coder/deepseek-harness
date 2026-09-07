import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileProfileBundles } from '../src/profile-plugins.ts'
import type { ProfileManifest } from '../src/profile.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { readonly profile: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-plugins-'))
  roots.push(root)
  const profile = join(root, 'profile')
  mkdirSync(profile, { recursive: true })
  return { profile }
}

function writeProfile(profile: string, manifest: ProfileManifest): void {
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function readBundles(profile: string): string[] | undefined {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as ProfileManifest
  return manifest.dsh?.profile?.bundles
}

describe('reconcileProfileBundles', () => {
  it('adds, removes, and reports dependency-managed package roles', () => {
    const { profile } = fixture()
    const before: ProfileManifest = {
      dependencies: { '@fixture/removed': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fixture/removed'] } },
    }
    const after: ProfileManifest = {
      dependencies: { '@fixture/added': '2.0.0', '@fixture/plain': '3.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@fixture/removed'] } },
    }

    const result = reconcileProfileBundles(before, after, new Set(['@fixture/added']))
    expect(result).toMatchObject({
      changed: true,
      addedBundles: ['@fixture/added'],
      removedBundles: ['@fixture/removed'],
      addedPlainDependencies: ['@fixture/plain'],
    })
    writeProfile(profile, result.manifest)
    expect(readBundles(profile)).toEqual(['@deepseek-ai/dsh-base', '@fixture/added'])
  })

  it('activates an updated dependency that gains a bundle declaration', () => {
    const { profile } = fixture()
    const before: ProfileManifest = {
      dependencies: { '@fixture/plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }
    const after: ProfileManifest = {
      dependencies: { '@fixture/plugin': '2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }

    const result = reconcileProfileBundles(before, after, new Set(['@fixture/plugin']))
    expect(result.addedBundles).toEqual(['@fixture/plugin'])
    writeProfile(profile, result.manifest)
    expect(readBundles(profile)).toEqual(['@deepseek-ai/dsh-base', '@fixture/plugin'])
  })
})
