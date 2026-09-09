/** Compact per-session accounting from owned raw events and their recorded routes. */

import type {} from '@deepseek-ai/dsh-compaction/types'
import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { normalizeTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { dateOf, shiftDate } from './calendar.ts'
import type { UsageDay, UsageModel, UsageRequest, UsageSnapshot } from './types.ts'

/** Only daily counters and model totals are retained after an observation lease closes. */
export interface SessionUsage {
  readonly days: Map<string, SessionUsageDay>
}

/** Session-local daily counters; nonzero messages identify one active session. */
interface SessionUsageDay {
  messages: number
  missing: number
  models: Map<string, UsageModel>
}

interface Route {
  provider: string
  model: string
}

interface Attempt {
  time: number
  route: Route
  sample?: { tokens: number; time: number }
  finished?: true
}

function addModel(models: Map<string, UsageModel>, route: Route, tokens: number): void {
  const key = JSON.stringify([route.provider, route.model])
  const existing = models.get(key)
  models.set(key, { provider: route.provider, model: route.model, tokens: (existing?.tokens ?? 0) + tokens })
}

function sortedModels(models: Map<string, UsageModel>): UsageModel[] {
  return [...models.values()].sort((left, right) => right.tokens - left.tokens
    || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
}

/**
 * Fold only events owned by a session, retaining inherited headers for route attribution.
 * @param observation - immutable live or persisted log observation.
 * @param formatter - viewer-local date formatter.
 * @returns compact day summaries without references to session events.
 */
export function foldSessionUsage(observation: SessionObservation, formatter: Intl.DateTimeFormat): SessionUsage {
  const days = new Map<string, SessionUsageDay>()
  let route: Route = { provider: '', model: '' }
  let attempt: Attempt | undefined
  const dayAt = (time: number): SessionUsageDay => {
    const date = dateOf(formatter, time)
    let day = days.get(date)
    if (day === undefined) {
      day = { messages: 0, missing: 0, models: new Map() }
      days.set(date, day)
    }
    return day
  }
  const closeAttempt = (): void => {
    if (attempt === undefined) return
    if (attempt.sample === undefined) dayAt(attempt.time).missing += 1
    else addModel(dayAt(attempt.sample.time).models, attempt.route, attempt.sample.tokens)
    attempt = undefined
  }
  const sample = (usage: TokenUsage | undefined, time: number, source: Route): void => {
    attempt ??= { time, route: source }
    attempt.route = source
    if (usage === undefined) return
    attempt.time = time
    const normalized = normalizeTokenUsage(usage)
    if (normalized !== undefined) attempt.sample = { tokens: normalized.totalTokens, time }
  }

  for (const event of observation.events) {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      route = { provider, model }
    }
    if (event.seq < observation.inheritedEventCount) continue
    switch (event.type) {
      case 'request/header':
        if (attempt?.finished === true) {
          closeAttempt()
          attempt = { time: event.time, route }
        }
        break
      case 'user/message':
        if (observation.header.origin !== 'subagent' && event.data.source.kind === 'user') {
          dayAt(event.time).messages += 1
        }
        break
      case 'step/start':
      case 'llm/retry-started':
        closeAttempt()
        attempt = { time: event.time, route }
        break
      case 'assistant/chunk':
        if (attempt?.finished === true) {
          closeAttempt()
          attempt = { time: event.time, route }
        }
        if (event.data.chunk.type === 'usage') sample(event.data.chunk.usage, event.time, route)
        if (event.data.chunk.type === 'finish'
          && (event.data.chunk.reason.kind === 'error' || event.data.chunk.reason.kind === 'aborted')) {
          attempt ??= { time: event.time, route }
          attempt.finished = true
        }
        break
      case 'assistant/message':
        sample(event.data.usage, event.time, event.data.message.source)
        break
      case 'step/end':
        closeAttempt()
        break
      case 'compaction/summary': {
        const usage = event.data.usage === undefined ? undefined : normalizeTokenUsage(event.data.usage)
        if (usage !== undefined) addModel(dayAt(event.time).models, event.data, usage.totalTokens)
        else if (event.data.llmStreamCall === true || event.data.usage !== undefined) dayAt(event.time).missing += 1
        break
      }
      default:
        // SessionEventMap is extensible; unrelated durable events do not report usage.
        break
    }
  }
  closeAttempt()
  return { days }
}

/**
 * Combine session-local summaries into the selected interval and annual activity grid.
 * @param summaries - one compact summary per unique readable session.
 * @param request - selected range and viewer time zone.
 * @param generatedAt - observation time in Unix epoch milliseconds.
 * @param formatter - validated formatter for the same time zone.
 * @param unreadableSessions - failed session observations.
 * @returns a detached statistics response.
 */
export function aggregateUsage(
  summaries: readonly SessionUsage[], request: UsageRequest, generatedAt: number,
  formatter: Intl.DateTimeFormat, unreadableSessions: number,
): UsageSnapshot {
  const to = dateOf(formatter, generatedAt)
  const from = shiftDate(to, 1 - request.days)
  const daily: UsageDay[] = Array.from({ length: request.days }, (_, index) => ({
    date: shiftDate(from, index), tokens: 0, messages: 0, sessions: 0, models: [],
  }))
  const selected = new Map(daily.map(day => [day.date, { day, models: new Map<string, UsageModel>() }]))
  const models = new Map<string, UsageModel>()
  const activity = new Map<string, number>()
  let sessionCount = 0
  let missingUsageAttempts = 0
  for (const summary of summaries) {
    let active = false
    for (const [date, source] of summary.days) {
      if (source.messages > 0) activity.set(date, (activity.get(date) ?? 0) + source.messages)
      const entry = selected.get(date)
      if (entry === undefined) continue
      const { day, models: modelsOnDay } = entry
      missingUsageAttempts += source.missing
      day.messages += source.messages
      if (source.messages > 0) {
        day.sessions += 1
        active = true
      }
      for (const model of source.models.values()) {
        day.tokens += model.tokens
        addModel(models, model, model.tokens)
        addModel(modelsOnDay, model, model.tokens)
      }
    }
    if (active) sessionCount += 1
  }
  for (const { day, models: modelsOnDay } of selected.values()) day.models = sortedModels(modelsOnDay)
  const orderedModels = sortedModels(models)
  let currentStreak = 0
  for (let date = to; activity.has(date); date = shiftDate(date, -1)) currentStreak += 1
  return {
    ...request, from, to, generatedAt,
    summary: {
      totalTokens: daily.reduce((total, day) => total + day.tokens, 0),
      sessionCount,
      messageCount: daily.reduce((total, day) => total + day.messages, 0),
      activeDays: daily.filter(day => day.messages > 0).length,
      currentStreak,
      mostUsedModel: orderedModels[0] === undefined ? null : { ...orderedModels[0] },
    },
    daily,
    models: orderedModels,
    heatmap: Array.from({ length: 365 }, (_, index) => {
      const date = shiftDate(to, index - 364)
      return { date, messages: activity.get(date) ?? 0 }
    }),
    coverage: { unreadableSessions, missingUsageAttempts },
  }
}
