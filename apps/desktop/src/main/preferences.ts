/** Desktop-main preference persistence. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredDesktopPreferences {
  globalShortcut: string | null
  launchAtLogin: boolean
}

export const DEFAULT_DESKTOP_PREFERENCES: StoredDesktopPreferences = {
  globalShortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
}

/** Electron global-shortcut operations used by the preference owner. */
export interface DesktopShortcutRegistry {
  unregisterAll(): void
  register(accelerator: string, callback: () => void): boolean
}

/** Replace the configured accelerator and report conflicts without throwing. */
export function replaceGlobalShortcut(
  registry: DesktopShortcutRegistry,
  accelerator: string | null,
  callback: () => void,
): boolean {
  registry.unregisterAll()
  if (accelerator === null) return true
  try {
    return registry.register(accelerator, callback)
  } catch {
    return false
  }
}

/** Read the supported settings, ignoring unknown or invalid fields. */
export async function readDesktopPreferences(path: string): Promise<StoredDesktopPreferences> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    return {
      globalShortcut: value.globalShortcut === null || typeof value.globalShortcut === 'string'
        ? value.globalShortcut
        : DEFAULT_DESKTOP_PREFERENCES.globalShortcut,
      launchAtLogin: typeof value.launchAtLogin === 'boolean'
        ? value.launchAtLogin
        : DEFAULT_DESKTOP_PREFERENCES.launchAtLogin,
    }
  } catch {
    return { ...DEFAULT_DESKTOP_PREFERENCES }
  }
}

/** Atomically persist Desktop preferences. */
export async function writeDesktopPreferences(path: string, value: StoredDesktopPreferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
