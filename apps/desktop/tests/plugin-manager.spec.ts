import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getLocale: () => 'en-US',
  },
  dialog: { showMessageBox: vi.fn() },
}))

import { DesktopPluginManager, parseDesktopPluginRequest } from '../src/main/plugin-manager.ts'

const roots: string[] = []

describe('parseDesktopPluginRequest', () => {
  it('accepts exact requests and rejects extra package-manager fields', () => {
    expect(parseDesktopPluginRequest({ action: 'install', spec: ' @fixture/plugin ' }))
      .toEqual({ action: 'install', spec: '@fixture/plugin' })
    expect(parseDesktopPluginRequest({ action: 'remove', name: '@fixture/plugin' }))
      .toEqual({ action: 'remove', name: '@fixture/plugin' })
    expect(() => parseDesktopPluginRequest({ action: 'install', spec: '@fixture/plugin', '--prod': true }))
      .toThrow('invalid request')
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ readonly home: string; readonly live: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugins-'))
  roots.push(home)
  const live = join(home, 'profiles', 'desktop')
  await mkdir(join(live, 'node_modules'), { recursive: true })
  await writeFile(join(live, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
    dependencies: {},
  }, null, 2)}\n`)
  await writeFile(join(live, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(join(live, 'cordis.patch.yml'), '# user-owned marker\n[]\n')
  return { home, live }
}

async function installFixturePackage(
  profile: string,
  options: { readonly scripts?: Record<string, string>; readonly missingClient?: boolean } = {},
): Promise<void> {
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>
  }
  manifest.dependencies['@fixture/desktop-plugin'] = '1.2.3'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const packageRoot = join(profile, 'node_modules', '@fixture', 'desktop-plugin')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@fixture/desktop-plugin',
    version: '1.2.3',
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(options.missingClient ? { client: { platform: 'web' } } : {}),
    },
    ...(options.missingClient ? { exports: { './client': './lib/client.js' } } : {}),
    ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
  }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      "@fixture/desktop-plugin":',
    '        specifier: 1.2.3',
    '        version: 1.2.3',
    'packages:',
    '  "@fixture/desktop-plugin@1.2.3":',
    '    resolution:',
    '      integrity: sha512-fixture',
    '',
  ].join('\n'))
}

async function installBundleClientRow(profile: string, built: boolean): Promise<void> {
  const bundleRoot = join(profile, 'node_modules', '@fixture', 'desktop-plugin')
  await writeFile(join(bundleRoot, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-client',
    "      name: '@fixture/client-row'",
    '',
  ].join('\n'))
  const clientRoot = join(profile, 'node_modules', '@fixture', 'client-row')
  await mkdir(join(clientRoot, 'lib'), { recursive: true })
  await writeFile(join(clientRoot, 'package.json'), `${JSON.stringify({
    name: '@fixture/client-row',
    version: '4.5.6',
    exports: { './client': './lib/client.js' },
    dsh: { client: { platform: 'web', inject: [] } },
  }, null, 2)}\n`)
  if (built) await writeFile(join(clientRoot, 'lib', 'client.js'), 'export {}\n')
}

function manager(
  home: string,
  runPackageManager: (cwd: string, args: readonly string[]) => Promise<string>,
  startHost: () => Promise<void> = async () => {},
) {
  const hooks = {
    stopHost: vi.fn(async () => {}),
    startHost: vi.fn(startHost),
    reloadWindows: vi.fn(),
    parentWindow: () => undefined,
  }
  return {
    hooks,
    value: new DesktopPluginManager(hooks, {
      home: () => home,
      runPackageManager,
      confirm: async () => true,
    }),
  }
}

describe('DesktopPluginManager', () => {
  it('stages metadata without changing the live profile', async () => {
    const { home, live } = await fixture()
    const before = await readFile(join(live, 'package.json'), 'utf8')
    const { value } = manager(home, async (profile, args) => {
      expect(args).toEqual(['add', '--ignore-scripts', '--save-exact', '--', '@fixture/desktop-plugin'])
      await installFixturePackage(profile)
      return ''
    })

    const staged = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })
    expect(staged.packages).toEqual([{
      name: '@fixture/desktop-plugin',
      version: '1.2.3',
      spec: '1.2.3',
      resolution: 'integrity:sha512-fixture',
      bundlePatch: './cordis.patch.yml',
      clientBundle: 'not-declared',
    }])
    expect(await readFile(join(live, 'package.json'), 'utf8')).toBe(before)
  })

  it('rejects a newly introduced lifecycle script without changing the live profile', async () => {
    const { home, live } = await fixture()
    const before = await readFile(join(live, 'package.json'), 'utf8')
    const { value } = manager(home, async (profile) => {
      await installFixturePackage(profile, { scripts: { install: 'node install.js' } })
      return ''
    })

    await expect(value.stage({ action: 'install', spec: '@fixture/desktop-plugin' }))
      .rejects.toThrow('install scripts are not allowed')
    expect(await readFile(join(live, 'package.json'), 'utf8')).toBe(before)
  })

  it('rejects a declared Client package whose built bundle is absent', async () => {
    const { home } = await fixture()
    const { value } = manager(home, async (profile) => {
      await installFixturePackage(profile, { missingClient: true })
      return ''
    })

    await expect(value.stage({ action: 'install', spec: '@fixture/desktop-plugin' }))
      .rejects.toThrow('declares dsh.client without a built ./client export')
  })

  it('validates Client rows declared inside an installed bundle patch', async () => {
    const { home } = await fixture()
    const { value } = manager(home, async (profile) => {
      await installFixturePackage(profile)
      await installBundleClientRow(profile, true)
      return ''
    })

    const staged = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })
    expect(staged.packages[0]?.clientBundle).toBe('verified')
  })

  it('rejects a missing Client artifact from a bundle patch row', async () => {
    const { home } = await fixture()
    const { value } = manager(home, async (profile) => {
      await installFixturePackage(profile)
      await installBundleClientRow(profile, false)
      return ''
    })

    await expect(value.stage({ action: 'install', spec: '@fixture/desktop-plugin' }))
      .rejects.toThrow('@fixture/client-row declares dsh.client without a built ./client export')
  })

  it('atomically replaces the complete profile and starts the new Host', async () => {
    const { home, live } = await fixture()
    const { value, hooks } = manager(home, async (profile) => {
      await installFixturePackage(profile)
      return ''
    })
    const staged = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })

    await value.apply(staged.token)

    const applied = JSON.parse(await readFile(join(live, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(applied.dependencies).toEqual({ '@fixture/desktop-plugin': '1.2.3' })
    expect(applied.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@fixture/desktop-plugin',
    ])
    expect(await readFile(join(live, 'cordis.patch.yml'), 'utf8')).toContain('user-owned marker')
    expect(hooks.stopHost).toHaveBeenCalledTimes(1)
    expect(hooks.startHost).toHaveBeenCalledTimes(1)
    expect(hooks.reloadWindows).toHaveBeenCalledTimes(1)
  })

  it('restores the previous profile and restarts its Host when the candidate fails readiness', async () => {
    const { home, live } = await fixture()
    const before = await readFile(join(live, 'package.json'), 'utf8')
    let starts = 0
    const { value, hooks } = manager(home, async (profile) => {
      await installFixturePackage(profile)
      return ''
    }, async () => {
      starts += 1
      if (starts === 1) throw new Error('candidate not ready')
    })
    const staged = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })

    await expect(value.apply(staged.token)).rejects.toThrow('was rolled back')
    expect(await readFile(join(live, 'package.json'), 'utf8')).toBe(before)
    expect(hooks.stopHost).toHaveBeenCalledTimes(2)
    expect(hooks.startHost).toHaveBeenCalledTimes(2)
    expect(hooks.reloadWindows).toHaveBeenCalledTimes(1)
  })

  it('rejects a resolved transaction after another transaction replaces the profile', async () => {
    const { home } = await fixture()
    const { value, hooks } = manager(home, async (profile) => {
      await installFixturePackage(profile)
      return ''
    })
    const first = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })
    const stale = await value.stage({ action: 'install', spec: '@fixture/desktop-plugin' })

    await value.apply(first.token)
    await expect(value.apply(stale.token)).rejects.toThrow('profile changed since this transaction was resolved')
    expect(hooks.stopHost).toHaveBeenCalledTimes(1)
  })
})
