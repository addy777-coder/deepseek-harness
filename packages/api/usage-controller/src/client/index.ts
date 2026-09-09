/** Client usage query service and connection-generation refresh wiring. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { ClientUsageModel } from './model.ts'
import { UsageController, type IUsage } from './service.ts'

export { ClientUsageModel } from './model.ts'
export type { UsageClientSnapshot, UsageRemote } from './model.ts'
export { UsageController } from './service.ts'
export type { IUsage } from './service.ts'
export type {
  UsageDay, UsageHeatmapDay, UsageModel, UsageRequest, UsageSnapshot, UsageSummary,
} from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free usage query state for the current Host data directory. */
    usage: IUsage
  }
}

/** Required generated Remote service and usage namespace. */
export const inject = ['remote', 'remote.usage']

/**
 * Install lazy usage state and refresh previously requested statistics after reconnecting.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const controller = new UsageController(ctx, new ClientUsageModel(ctx.remote.usage))
  ctx.on('connection/reset', () => { void controller.refresh() })
}
