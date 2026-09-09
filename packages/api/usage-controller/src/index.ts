/** Read-only usage Remote owner over the complete live-preferred session corpus. */

import { Context, symbols } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { aggregateUsage, foldSessionUsage, type SessionUsage } from './aggregate.ts'
import { dateFormatter } from './calendar.ts'
import type { UsageRequest, UsageSnapshot } from './types.ts'

export type * from './types.ts'

/** Deployment limits for parallel reads and compact session summaries. */
export interface Config {
  /** Maximum simultaneous session observations within one request. */
  concurrentReads: number
  /** Maximum compact session summaries retained between requests. */
  cacheSize: number
}

interface CachedSession {
  readonly identity: object | undefined
  readonly source: SessionObservation['source']
  readonly cursor: SessionObservation['cursor']
  readonly revision: SessionObservation['revision']
  readonly timeZone: string
  readonly summary: SessionUsage
}

const requestSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  timeZone: z.string().regex(/^[A-Za-z]/),
})

function persistenceIdentity(ctx: Context): object | undefined {
  const persistence = ctx.get('sessionPersistence')
  // Cordis returns a fresh caller-bound proxy; cache revisions belong to its underlying provider.
  return persistence === undefined ? undefined : Reflect.get(persistence, symbols.original) as object
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the read-only `usage` Remote namespace. */
    usageController: UsageController
  }
}

/** Host service backing generated `ctx.remote.usage.get()`. */
export class UsageController extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessions']
  static Config: Schema<Config> = Schema.object({
    concurrentReads: Schema.number().min(1).step(1).required(),
    cacheSize: Schema.number().min(1).step(1).required(),
  })

  private readonly cache = new Map<SessionId, CachedSession>()
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<UsageSnapshot>>()

  /**
   * @param ctx - Host context with the live-preferred session query service.
   * @param config - explicit positive safe-integer read and cache limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'usageController', { namespace: 'usage' })
    for (const key of ['concurrentReads', 'cacheSize'] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
        throw new TypeError(`usage controller: ${key} must be a positive safe integer`)
      }
    }
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.active)
      this.cache.clear()
    }, 'usageController.reads')
  }

  /**
   * Aggregate readable history without attaching sessions or starting agents.
   * @param request - 7/30-day calendar interval and valid IANA time zone.
   * @param signal - caller cancellation, combined with plugin lifetime.
   * @returns exact reported usage and explicit incomplete-history counters.
   * @throws RemoteError for invalid requests, corpus listing failures, or cancellation.
   */
  @Remote
  async get(request: UsageRequest, signal: AbortSignal): Promise<UsageSnapshot> {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid usage interval or time zone', {})
    let formatter: Intl.DateTimeFormat
    try {
      formatter = dateFormatter(parsed.data.timeZone)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', 'usage timeZone must identify an IANA time zone', {}, { cause: error })
    }
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const operation = this.collect(parsed.data, formatter, combined)
    this.active.add(operation)
    try {
      return await operation
    } catch (error: unknown) {
      if (combined.aborted) throw new RemoteError('gateway/cancelled', 'usage read was cancelled', {})
      throw new RemoteError('gateway/internal', 'usage session history could not be read', {}, { cause: error })
    } finally {
      this.active.delete(operation)
    }
  }

  private async collect(request: UsageRequest, formatter: Intl.DateTimeFormat, signal: AbortSignal): Promise<UsageSnapshot> {
    signal.throwIfAborted()
    const generatedAt = Date.now()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal.throwIfAborted()
    const summaries: SessionUsage[] = []
    let unreadableSessions = 0
    const remaining = records.values()
    const worker = async (): Promise<void> => {
      for (;;) {
        signal.throwIfAborted()
        const next = remaining.next()
        if (next.done) return
        const record = next.value
        try {
          summaries.push(await this.readSummary(record.header.id, request.timeZone, formatter, signal))
        } catch (error: unknown) {
          signal.throwIfAborted()
          // A corrupt, removed, or unreadable session leaves the remaining corpus usable.
          this.ctx.logger.warn(`usage: session ${record.header.id} could not be read`, error)
          unreadableSessions += 1
        }
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(this.config.concurrentReads, records.length) }, worker))
    signal.throwIfAborted()
    if (records.length > 0 && summaries.length === 0) throw new Error('all usage session observations failed')
    const visible = new Set(records.map(record => record.header.id))
    for (const id of this.cache.keys()) if (!visible.has(id)) this.cache.delete(id)
    return aggregateUsage(summaries, request, generatedAt, formatter, unreadableSessions)
  }

  private async readSummary(id: SessionId, timeZone: string, formatter: Intl.DateTimeFormat, signal: AbortSignal): Promise<SessionUsage> {
    let live = this.ctx.sessions.get(id)
    const cached = this.cache.get(id)
    if (cached !== undefined && cached.timeZone === timeZone) {
      if (live === undefined) {
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence !== undefined && cached.source === 'prepared' && cached.identity === persistenceIdentity(this.ctx)) {
          const snapshot = await persistence.stat(id, { signal })
          signal.throwIfAborted()
          live = this.ctx.sessions.get(id)
          if (live === undefined && snapshot !== undefined && snapshot.revision === cached.revision) {
            return this.touch(id, cached)
          }
        }
      }
      if (live !== undefined && cached.source === 'live' && cached.identity === live.header && cached.cursor === live.seq - 1) {
        return this.touch(id, cached)
      }
    }
    const persistenceBefore = persistenceIdentity(this.ctx)
    using observation = await this.ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' })
    signal.throwIfAborted()
    if (observation.source === 'prepared' && persistenceBefore !== persistenceIdentity(this.ctx)) {
      return foldSessionUsage(observation, formatter)
    }
    return this.summarize(observation, timeZone, formatter)
  }

  private touch(id: SessionId, cached: CachedSession): SessionUsage {
    this.cache.delete(id)
    this.cache.set(id, cached)
    return cached.summary
  }

  private summarize(observation: SessionObservation, timeZone: string, formatter: Intl.DateTimeFormat): SessionUsage {
    const id = observation.header.id
    const identity = observation.source === 'live' ? observation.header : persistenceIdentity(this.ctx)
    const summary = foldSessionUsage(observation, formatter)
    this.cache.delete(id)
    this.cache.set(id, {
      identity, source: observation.source, cursor: observation.cursor, revision: observation.revision, timeZone, summary,
    })
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.config.cacheSize) break
      this.cache.delete(oldest)
    }
    return summary
  }
}

export default UsageController
