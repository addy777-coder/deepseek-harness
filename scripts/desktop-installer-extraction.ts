/** Extract native Desktop installers into private temporary directories for verification. */
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type { VpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'
import { assertNever } from '../packages/util/values/src/index.ts'

/** Native archive format selected for the current Desktop target. */
export type DesktopInstallerFormat = 'nsis' | 'zip' | 'dmg' | 'appimage' | 'deb'

/** External extraction programs; each invocation waits for process exit. */
export interface DesktopExtractionTools {
  /**
   * Resolve a 7-Zip executable capable of reading the Windows installer.
   * @returns the installed executable or verified packaging-tool cache path.
   */
  sevenZip(): Promise<string>
  /**
   * Run one extraction or mount command without a shell.
   * @param command - executable name or absolute path.
   * @param args - command arguments, including paths as separate values.
   * @param cwd - private working directory for extracted output.
   * @returns after successful process exit; rejects on spawn or command failure.
   */
  run(command: string, args: readonly string[], cwd: string): Promise<void>
}

/**
 * Require a supported container for the host that will verify its contents.
 * @param artifact - installer or portable archive path.
 * @param target - native Desktop platform and architecture.
 * @returns the extractor format; incompatible extensions reject before extraction.
 */
export function desktopInstallerFormat(artifact: string, target: VpnTarget): DesktopInstallerFormat {
  const extension = extname(artifact).toLowerCase()
  if (target.platform === 'windows' && extension === '.exe') return 'nsis'
  if (target.platform === 'darwin' && extension === '.dmg') return 'dmg'
  if (target.platform !== 'linux' && extension === '.zip') return 'zip'
  if (target.platform === 'linux' && extension === '.appimage') return 'appimage'
  if (target.platform === 'linux' && extension === '.deb') return 'deb'
  throw new Error(`Desktop ${target.directory} cannot verify installer ${basename(artifact)}`)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function windowsApplication(directory: string, tools: DesktopExtractionTools, sevenZip: string): Promise<string> {
  if (await isFile(join(directory, 'DSH Desktop.exe'))) return directory
  const payloads = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && /^app-(?:64|x64)\.(?:7z|zip)$/u.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
  const [payload] = payloads
  if (payloads.length !== 1 || payload === undefined) throw new Error(`Desktop NSIS installer must contain one x64 payload; found ${payloads.length}`)
  const application = join(directory, 'application')
  await mkdir(application)
  await tools.run(sevenZip, ['x', payload, `-o${application}`, '-y', '-bd', '-bso0'], directory)
  return application
}

async function applicationDirectory(directory: string, target: VpnTarget): Promise<string> {
  if (target.platform !== 'darwin') return directory
  const applications = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
  const [application] = applications
  if (applications.length !== 1 || application?.name !== 'DSH Desktop.app') {
    throw new Error('Desktop macOS container must contain exactly one DSH Desktop.app')
  }
  return join(directory, application.name)
}

/**
 * Verify extracted installer contents while owning extraction and mount cleanup.
 * @param artifact - immutable local installer; its bytes and permissions remain unchanged.
 * @param target - native host that will run the extracted application.
 * @param tools - native archive and disk-image commands.
 * @param verify - verification callback; the extracted application exists until it settles.
 * @returns after verification and cleanup; failed verification also removes temporary files.
 */
export async function withExtractedDesktopInstaller(
  artifact: string,
  target: VpnTarget,
  tools: DesktopExtractionTools,
  verify: (application: string) => Promise<void>,
): Promise<void> {
  const format = desktopInstallerFormat(artifact, target)
  const source = resolve(artifact)
  if (!await isFile(source)) throw new Error(`Desktop installer is missing: ${source}`)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-installer-'))
  const local = relative(tmpdir(), temporary)
  if (!local.startsWith('dsh-desktop-installer-') || local.includes(sep)) throw new Error(`Unexpected extraction directory: ${temporary}`)
  const extracted = join(temporary, 'extracted')
  const mount = join(temporary, 'mount')
  let mounted = false
  try {
    await mkdir(extracted)
    let application: string
    switch (format) {
      case 'nsis': {
        const sevenZip = await tools.sevenZip()
        await tools.run(sevenZip, ['x', source, `-o${extracted}`, '-y', '-bd', '-bso0'], temporary)
        application = await windowsApplication(extracted, tools, sevenZip)
        break
      }
      case 'zip':
        if (target.platform === 'darwin') {
          await tools.run('ditto', ['-x', '-k', source, extracted], temporary)
        } else {
          await tools.run(await tools.sevenZip(), ['x', source, `-o${extracted}`, '-y', '-bd', '-bso0'], temporary)
        }
        application = await applicationDirectory(extracted, target)
        break
      case 'dmg':
        await mkdir(mount)
        await tools.run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, source], temporary)
        mounted = true
        application = await applicationDirectory(mount, target)
        break
      case 'appimage':
        await tools.run(source, ['--appimage-extract'], extracted)
        application = join(extracted, 'squashfs-root')
        break
      case 'deb':
        await tools.run('dpkg-deb', ['--extract', source, extracted], temporary)
        application = join(extracted, 'opt/DSH Desktop')
        break
      default:
        assertNever(format)
    }
    await verify(application)
  } finally {
    if (mounted) {
      try {
        await tools.run('hdiutil', ['detach', mount], temporary)
      } catch {
        // The verifier owns this read-only mount; force detachment after a busy-volume failure.
        await tools.run('hdiutil', ['detach', '-force', mount], temporary)
      }
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
