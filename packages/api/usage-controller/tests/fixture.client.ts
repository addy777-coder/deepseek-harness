import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { UsageRemote } from '../src/client/model.ts'
import type { UsageRequest, UsageSnapshot } from '../src/types.ts'

export const REQUEST: UsageRequest = { days: 30, timeZone: 'Asia/Shanghai' }

export function usage(request: UsageRequest = REQUEST, tokens = 120): UsageSnapshot {
  return {
    ...request,
    from: '2026-08-10',
    to: '2026-09-08',
    generatedAt: 1_788_825_600_000,
    summary: {
      totalTokens: tokens,
      sessionCount: 1,
      messageCount: 1,
      activeDays: 1,
      currentStreak: 1,
      mostUsedModel: null,
    },
    daily: [],
    models: [],
    heatmap: [],
    coverage: { unreadableSessions: 0, missingUsageAttempts: 0 },
  }
}

export class FakeUsageRemote implements UsageRemote {
  readonly calls: Array<{
    request: UsageRequest
    signal: AbortSignal | undefined
    result: PromiseWithResolvers<RemoteResult<UsageSnapshot>>
  }> = []

  get(request: UsageRequest, signal?: AbortSignal): Promise<RemoteResult<UsageSnapshot>> {
    const result = Promise.withResolvers<RemoteResult<UsageSnapshot>>()
    this.calls.push({ request, signal, result })
    return result.promise
  }

  settleAll(): void {
    for (const call of this.calls) call.result.resolve({ ok: true, value: usage(call.request) })
  }
}
