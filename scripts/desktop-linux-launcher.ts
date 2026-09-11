/** Require the shipped Linux launcher to retain Chromium sandboxing. */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const source = resolve(import.meta.dirname, '../apps/desktop/assets/linux/AppRun')

/**
 * Verify the launcher after electron-builder copies the unpacked app or an installer is extracted.
 * @param application - Linux application directory containing AppRun and dsh-desktop.
 * @returns after launcher bytes, permissions, and any AppImage desktop entry pass verification.
 */
export async function verifyDesktopLinuxLauncher(application: string): Promise<void> {
  const launcher = join(application, 'AppRun')
  const [expected, actual, metadata] = await Promise.all([
    readFile(source), readFile(launcher), stat(launcher),
  ])
  if (!actual.equals(expected)) throw new Error('Desktop AppRun differs from the sandbox-preserving launcher')
  if (!metadata.isFile() || (process.platform !== 'win32' && (metadata.mode & 0o111) === 0)) {
    throw new Error('Desktop AppRun is not executable')
  }
  let desktop: string
  try {
    desktop = await readFile(join(application, 'dsh-desktop.desktop'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const commands = desktop.split(/\r?\n/u).filter(line => line.startsWith('Exec='))
  if (commands.length !== 1 || /--(?:no-sandbox|disable-\S*-sandbox)(?:\s|=|$)/u.test(commands[0] ?? '')) {
    throw new Error('Desktop AppImage entry must retain the Chromium sandbox')
  }
}
