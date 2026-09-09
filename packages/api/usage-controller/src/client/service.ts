/** Client usage service exposes query commands and a framework-neutral observable. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { UsageRequest } from '../types.ts'
import type { ClientUsageModel, UsageClientSnapshot } from './model.ts'

/** Client-only usage service consumed by settings contributions. */
export interface IUsage {
  /** Query state; the renderer owns subscription hooks. */
  readonly snapshot: ObservableSnapshot<UsageClientSnapshot>
  /**
   * Select a date range, cancelling the preceding query.
   * @param request - date range and client-resolved IANA time zone.
   * @returns settlement with errors captured in the snapshot; disposed calls do no work.
   */
  load(request: UsageRequest): Promise<void>
  /**
   * Refresh the selected range with the current local time zone.
   * @returns settlement with errors captured in the snapshot; no-op before the first load.
   */
  refresh(): Promise<void>
}

/** Publishes the Client usage model and owns its quiescent disposal. */
export class UsageController extends Service implements IUsage {
  readonly snapshot: ObservableSnapshot<UsageClientSnapshot>

  /**
   * @param ctx - providing Client plugin context.
   * @param model - usage query state owned by this service.
   */
  constructor(ctx: Context, private readonly model: ClientUsageModel) {
    super(ctx, 'usage')
    this.snapshot = model
    ctx.effect(() => () => model.dispose(), 'usage-controller.client.model')
  }

  load(request: UsageRequest): Promise<void> {
    return this.model.load(request)
  }

  refresh(): Promise<void> {
    return this.model.refresh()
  }
}
