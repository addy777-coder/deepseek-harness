import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVpnTarget, type VpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'
import { desktopInstallerFormat, withExtractedDesktopInstaller, type DesktopExtractionTools } from './desktop-installer-extraction.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function write(path: string, content = 'fixture'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function fixture(target: VpnTarget, extension: string, nestedPayloads = 0) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-container-test-'))
  roots.push(root)
  const artifact = join(root, `DSH-Desktop-1.2.3.${extension}`)
  await write(artifact, 'immutable installer')
  const calls: string[] = []
  let temporary = ''
  const tools: DesktopExtractionTools = {
    sevenZip: async () => 'fixture-sevenzip',
    run: async (command, args, cwd) => {
      temporary ||= command === artifact ? dirname(cwd) : cwd
      calls.push(`${command} ${args[0]}`)
      if (command === 'fixture-sevenzip') {
        const output = args.find(arg => arg.startsWith('-o'))!.slice(2)
        if (args[1] === artifact && nestedPayloads > 0) {
          await write(join(output, '$PLUGINSDIR/app-64.7z'))
          if (nestedPayloads > 1) await write(join(output, '$PLUGINSDIR/app-x64.zip'))
        } else {
          await write(join(output, 'DSH Desktop.exe'))
        }
      } else if (command === 'ditto') {
        await write(join(args[3]!, 'DSH Desktop.app/Contents/MacOS/DSH Desktop'))
      } else if (command === 'hdiutil' && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1]!
        await write(join(mount, 'DSH Desktop.app/Contents/MacOS/DSH Desktop'))
      } else if (command === 'dpkg-deb') {
        await write(join(args[2]!, 'opt/DSH Desktop/dsh-desktop'))
      } else if (command === artifact) {
        await write(join(cwd, 'squashfs-root/dsh-desktop'))
      }
    },
  }
  return { artifact, tools, calls, temporary: () => temporary, target }
}

const cases = [
  { platform: 'win32', arch: 'x64', extension: 'exe', format: 'nsis' },
  { platform: 'win32', arch: 'x64', extension: 'zip', format: 'zip' },
  { platform: 'darwin', arch: 'arm64', extension: 'dmg', format: 'dmg' },
  { platform: 'darwin', arch: 'x64', extension: 'zip', format: 'zip' },
  { platform: 'linux', arch: 'x64', extension: 'AppImage', format: 'appimage' },
  { platform: 'linux', arch: 'x64', extension: 'deb', format: 'deb' },
]

describe('Desktop final installer extraction', () => {
  it.each(cases)('verifies extracted $extension contents and cleans its private directory', async ({ platform, arch, extension, format }) => {
    const { artifact, tools, calls, temporary, target } = await fixture(resolveVpnTarget(platform, arch), extension)
    expect(desktopInstallerFormat(artifact, target)).toBe(format)
    const before = await readFile(artifact)
    let verified = false
    await withExtractedDesktopInstaller(artifact, target, tools, async (application) => {
      expect((await stat(application)).isDirectory()).toBe(true)
      if (format === 'dmg') expect(calls).not.toContain('hdiutil detach')
      verified = true
    })
    expect(verified).toBe(true)
    expect(await readFile(artifact)).toEqual(before)
    await expect(stat(temporary())).rejects.toMatchObject({ code: 'ENOENT' })
    if (format === 'dmg') expect(calls).toContain('hdiutil detach')
  })

  it('expands the single NSIS app-64.7z payload before verification', async () => {
    const { artifact, tools, calls, target } = await fixture(resolveVpnTarget('win32', 'x64'), 'exe', 1)
    await withExtractedDesktopInstaller(artifact, target, tools, async (application) => {
      expect(await readFile(join(application, 'DSH Desktop.exe'), 'utf8')).toBe('fixture')
    })
    expect(calls).toEqual(['fixture-sevenzip x', 'fixture-sevenzip x'])
  })

  it('rejects ambiguous NSIS payloads and cleans the extraction', async () => {
    const { artifact, tools, temporary, target } = await fixture(resolveVpnTarget('win32', 'x64'), 'exe', 2)
    await expect(withExtractedDesktopInstaller(artifact, target, tools, async () => {})).rejects.toThrow('one x64 payload')
    await expect(stat(temporary())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detaches a DMG and removes temporary files after verification fails', async () => {
    const { artifact, tools, calls, temporary, target } = await fixture(resolveVpnTarget('darwin', 'arm64'), 'dmg')
    await expect(withExtractedDesktopInstaller(artifact, target, tools, async () => {
      throw new Error('VPN digest mismatch')
    })).rejects.toThrow('VPN digest mismatch')
    expect(calls).toContain('hdiutil detach')
    await expect(stat(temporary())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('forces a busy DMG mount to detach before removing its directory', async () => {
    const { artifact, tools, temporary, target } = await fixture(resolveVpnTarget('darwin', 'arm64'), 'dmg')
    const run = tools.run.bind(tools)
    const observed: string[][] = []
    tools.run = async (command, args, cwd) => {
      await run(command, args, cwd)
      if (command === 'hdiutil' && args[0] === 'detach') {
        observed.push([...args])
        expect((await stat(cwd)).isDirectory()).toBe(true)
        if (!args.includes('-force')) throw new Error('volume is busy')
      }
    }
    await withExtractedDesktopInstaller(artifact, target, tools, async () => {})
    expect(observed.map(args => args.includes('-force'))).toEqual([false, true])
    await expect(stat(temporary())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the mount directory when both DMG detachment attempts fail', async () => {
    const { artifact, tools, temporary, target } = await fixture(resolveVpnTarget('darwin', 'arm64'), 'dmg')
    const run = tools.run.bind(tools)
    tools.run = async (command, args, cwd) => {
      await run(command, args, cwd)
      if (command === 'hdiutil' && args[0] === 'detach') throw new Error('cannot detach volume')
    }
    await expect(withExtractedDesktopInstaller(artifact, target, tools, async () => {})).rejects.toThrow('cannot detach volume')
    roots.push(temporary())
    expect((await stat(join(temporary(), 'mount/DSH Desktop.app'))).isDirectory()).toBe(true)
  })

  it('cleans partial output when extraction fails', async () => {
    const { artifact, temporary, target, tools } = await fixture(resolveVpnTarget('win32', 'x64'), 'zip')
    const run = tools.run.bind(tools)
    tools.run = async (...args) => {
      await run(...args)
      throw new Error('archive is truncated')
    }
    await expect(withExtractedDesktopInstaller(artifact, target, tools, async () => {})).rejects.toThrow('truncated')
    await expect(stat(temporary())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['app.dmg', 'app.deb', 'app.AppImage', 'app.tar.gz'])('rejects %s for a Windows host', (artifact) => {
    expect(() => desktopInstallerFormat(artifact, resolveVpnTarget('win32', 'x64'))).toThrow('cannot verify installer')
  })
})
