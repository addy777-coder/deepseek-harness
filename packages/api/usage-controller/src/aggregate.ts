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
  let pendingAt: number | undefined
  let inStep = false
  const dayAt = (time: number): SessionUsageDay => {
    const date = dateOf(formatter, time)
    let day = days.get(date)
    if (day === undefined) {
      day = { messages: 0, missing: 0, models: new Map() }
      days.set(date, day)
    }
    return day
  }
  const closePending = (): void => {
    if (pendingAt !== undefined) dayAt(pendingAt).missing += 1
    pendingAt = undefined
  }

  for (const event of observation.events) {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      route = { provider, model }
    }
    if (event.seq < observation.inheritedEventCount) continue
    switch (event.type) {
      case 'request/header':
        if (inStep) pendingAt ??= event.time
        break
      case 'user/message':
        if (observation.header.origin !== 'subagent' && event.data.source.kind === 'user') {
          dayAt(event.time).messages += 1
        }
        break
      case 'step/start':
        inStep = true
        closePending()
        pendingAt = event.time
        break
      case 'llm/retry-started':
        closePending()
        pendingAt = event.time
        break
      case 'assistant/attempt':
      case 'assistant/message': {
        let reported: { usage: TokenUsage; time: number } | undefined
        for (const record of event.data.stream) {
          if (record.type === 'chunk' && record.chunk.type === 'usage') {
            reported = { usage: record.chunk.usage, time: record.time }
          }
        }
        if (event.type === 'assistant/message' && event.data.usage !== undefined) {
          reported = { usage: event.data.usage, time: event.time }
        }
        const normalized = reported === undefined ? undefined : normalizeTokenUsage(reported.usage)
        if (normalized === undefined || reported === undefined) dayAt(event.time).missing += 1
        else addModel(dayAt(reported.time).models,
          event.type === 'assistant/message' ? event.data.message.source : route, normalized.totalTokens)
        pendingAt = undefined
        break
      }
      case 'step/end':
        closePending()
        inStep = false
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
  closePending()
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
