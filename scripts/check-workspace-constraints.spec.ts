/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type PackageManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('package payload constraints', () => {
  it('publishes the independent POSIX inspector and rejects a missing or undeclared runtime', () => {
    const manifest = JSON.parse(readFileSync(new URL('../packages/subprocess/subprocess-local/package.json', import.meta.url), 'utf8')) as PackageManifest
    const runtime = 'lib/posix-process-inspector.js'
    const files = ['lib/index.js', runtime, 'scripts/ensure-spawn-helper.mjs', 'lib/types/**/*.d.ts']
    const workspace = { dir: 'packages/subprocess/subprocess-local', manifest: { ...manifest, files } }

    expect(expectedDshPackageFiles(manifest)).toEqual(files)
    expect(checkWorkspaceManifest(workspace)).toEqual([])
    expect(checkWorkspaceManifest({
      ...workspace,
      manifest: { ...manifest, files: files.filter(file => file !== runtime) },
    })).toEqual([expect.stringContaining('package.json files must be')])
    expect(checkWorkspaceManifest({
      ...workspace,
      manifest: {
        ...manifest,
        files,
        exports: { ...manifest.exports, './posix-process-inspector': undefined },
      },
    })).toEqual([expect.stringContaining('package.json files must be')])
  })

  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })

  it('includes a separately bundled Web carrier when the export names it', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-carrier',
      exports: { './web': { default: './lib/web.js' } },
    })).toEqual([
      'lib/index.js',
      'lib/web.js',
      'lib/types/**/*.d.ts',
    ])
  })

  it('includes the Connection Host entries shared runtime chunk', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-client-connection',
      exports: {
        './client': { default: './lib/client.js' },
        './web': { default: './lib/web.js' },
      },
    })).toEqual([
      'lib/index.js',
      'lib/client.js',
      'lib/web.js',
      'lib/api-path-*.js',
      'lib/types/**/*.d.ts',
    ])
  })

  it('includes the pure profile-plugin reconciler without widening the root boot bundle', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-app-boot',
      exports: { './profile-plugins': { default: './lib/profile-plugins.js' } },
    })).toEqual([
      'lib/index.js',
      'lib/profile-plugins.js',
      'lib/types/**/*.d.ts',
    ])
  })
})
