/** Linux launcher packaging and sandbox-preserving execution. */
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDesktopLinuxLauncher } from './desktop-linux-launcher.ts'

const source = resolve(import.meta.dirname, '../apps/desktop/assets/linux/AppRun')
const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-linux-launcher-'))
  cleanups.push(directory)
  await copyFile(source, join(directory, 'AppRun'))
  await chmod(join(directory, 'AppRun'), 0o755)
  return directory
}

describe('Desktop Linux launcher', () => {
  it('ships a launcher override and removes electron-builder default sandbox switches', async () => {
    const configuration = yaml.load(await readFile(resolve(import.meta.dirname, '../apps/desktop/electron-builder.yml'), 'utf8'))
    expect(configuration).toMatchObject({
      appImage: { executableArgs: [] },
      linux: { extraFiles: [{ from: 'assets/linux/AppRun', to: 'AppRun' }] },
    })
  })

  it('verifies the packaged launcher and AppImage desktop entry', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'dsh-desktop.desktop'), '[Desktop Entry]\nExec=AppRun %U\n')
    await expect(verifyDesktopLinuxLauncher(directory)).resolves.toBeUndefined()
  })

  it('rejects a launcher with automatic sandbox downgrade logic', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'AppRun'), '#!/bin/bash\nexec "$APPDIR/dsh-desktop" --no-sandbox "$@"\n')
    await expect(verifyDesktopLinuxLauncher(directory)).rejects.toThrow('differs from the sandbox-preserving launcher')
  })

  it.each(['--no-sandbox', '--no-sandbox=true', '--disable-gpu-sandbox'])('rejects sandbox switches in an AppImage desktop entry: %s', async (argument) => {
    const directory = await fixture()
    await writeFile(join(directory, 'dsh-desktop.desktop'), `[Desktop Entry]\nExec=AppRun ${argument} %U\n`)
    await expect(verifyDesktopLinuxLauncher(directory)).rejects.toThrow('must retain the Chromium sandbox')
  })

  it.skipIf(process.platform === 'win32')('rejects a launcher without executable permission', async () => {
    const directory = await fixture()
    await chmod(join(directory, 'AppRun'), 0o644)
    await expect(verifyDesktopLinuxLauncher(directory)).rejects.toThrow('not executable')
  })

  it('passes arguments unchanged even when a user-namespace heuristic would fail', async () => {
    const directory = await fixture()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'unshare'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 })
    await writeFile(join(directory, 'dsh-desktop'), '#!/usr/bin/env bash\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['--noprofile', '--norc', join(directory, 'AppRun'), 'one argument', 'dsh://open'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, APPDIR: directory.replaceAll('\\', '/'), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('<one argument>\n<dsh://open>\n')
  })

  it.each(['--no-sandbox', '--no-sandbox=true', '--disable-gpu-sandbox'])('refuses a sandbox-disabling invocation: %s', async (argument) => {
    const directory = await fixture()
    const result = spawnSync('bash', ['--noprofile', '--norc', join(directory, 'AppRun'), argument], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, APPDIR: directory.replaceAll('\\', '/') },
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requires the Chromium sandbox')
  })
})
