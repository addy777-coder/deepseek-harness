/** Prepare Electron's Node executable mode, then enter the real dsh CLI. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopHostLifecycleFrame } from '@deepseek-ai/dsh-desktop-transport'

interface UtilityParentPort {
  postMessage(message: DesktopHostLifecycleFrame): void
}

const parent = (process as unknown as { readonly parentPort: UtilityParentPort }).parentPort
parent.postMessage({ v: 1, t: 'startup', phase: 'bootstrap' })

const runtimeEntry = process.env.DSH_DESKTOP_DSH_ENTRY
parent.postMessage({ v: 1, t: 'startup', phase: 'profile' })
if (runtimeEntry !== undefined && runtimeEntry !== '') {
  await import(pathToFileURL(resolve(runtimeEntry)).href)
} else {
  await import('tsx/esm')
  await import(new URL('../../cli/src/bin.ts', import.meta.url).href)
}
