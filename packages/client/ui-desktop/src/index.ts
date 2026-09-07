/** Loader seat for the DSH Desktop client plugin. */
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'client-ui-desktop'

/** Host half intentionally contributes no service. */
export function apply(_ctx: Context): void {}
