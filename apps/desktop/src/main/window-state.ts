/** Durable main-window bounds with visible-display recovery. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Rectangle } from 'electron'

export const DEFAULT_MAIN_BOUNDS: Rectangle = { x: 120, y: 80, width: 1360, height: 900 }

function validRectangle(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(key => Number.isInteger(row[key]))
    && (row.width as number) >= 900
    && (row.height as number) >= 640
    && (row.width as number) <= 10_000
    && (row.height as number) <= 10_000
}

/** Read stored bounds, falling back when the record is absent or invalid. */
export async function readWindowBounds(path: string): Promise<Rectangle> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return validRectangle(parsed) ? parsed : { ...DEFAULT_MAIN_BOUNDS }
  } catch {
    return { ...DEFAULT_MAIN_BOUNDS }
  }
}

/** Keep at least one 80×80 area on a current display. */
export function visibleWindowBounds(bounds: Rectangle, displays: readonly Rectangle[]): Rectangle {
  const visible = displays.some((display) => {
    const width = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x)
    const height = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y)
    return width >= 80 && height >= 80
  })
  return visible ? bounds : { ...DEFAULT_MAIN_BOUNDS }
}

/** Atomically replace the bounds record. */
export async function writeWindowBounds(path: string, bounds: Rectangle): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(bounds)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
