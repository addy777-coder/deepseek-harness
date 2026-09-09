import { describe, expect, it } from 'vitest'
import { aggregateUsage, foldSessionUsage } from '../src/aggregate.ts'
import { dateFormatter, dateOf, shiftDate } from '../src/calendar.ts'
import { chunk, event, header, message, NOW, observation, turn, usage, user } from './helpers.ts'

const utc = dateFormatter('UTC')

function snapshot(...observations: ReturnType<typeof observation>[]) {
  return aggregateUsage(observations.map(value => foldSessionUsage(value, utc)), { days: 7, timeZone: 'UTC' }, NOW, utc, 0)
}

describe('usage accounting', () => {
  it('keeps the last valid reported sample and assigns it to its own local date', () => {
    const dayBefore = NOW - 86_400_000
    const result = snapshot(observation(turn(
      user(), chunk(usage(120), dayBefore), chunk(usage(150)), message({ inputTokens: 90, outputTokens: 20 }),
    )))
    expect(result.summary).toMatchObject({ totalTokens: 150, sessionCount: 1, messageCount: 1, activeDays: 1, currentStreak: 1 })
    expect(result.daily.at(-1)).toMatchObject({ tokens: 150, sessions: 1, messages: 1 })
    expect(result.daily.at(-2)?.tokens).toBe(0)
    expect(result.coverage.missingUsageAttempts).toBe(0)
    expect(result.models).toEqual([{ provider: 'deepseek', model: 'flash', tokens: 150 }])
  })

  it('lets final usage replace a stream sample and retains failure/cancellation samples across retries', () => {
    const result = snapshot(observation(turn(
      chunk(usage(100)),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'retry' } } } }),
      event('llm/retry', { turn: 1, step: 1 }),
      event('llm/retry-started', { turn: 1, step: 1 }),
      chunk(usage(200)), message(usage(250)),
    )), observation(turn(
      chunk(usage(80)),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'aborted' } } }),
    ), header('cancelled')))
    expect(result.summary.totalTokens).toBe(430)
    expect(result.coverage.missingUsageAttempts).toBe(0)
  })

  it('does not count a scheduled retry that never starts and retains an in-progress sample', () => {
    const result = snapshot(observation([
      ...turn(chunk(usage(80)), event('llm/retry', { turn: 1, step: 1 })).slice(0, -2),
    ]))
    expect(result.summary.totalTokens).toBe(80)
    expect(result.coverage.missingUsageAttempts).toBe(0)
  })

  it('counts context-overflow recovery attempts without a retry-started event', () => {
    const result = snapshot(observation(turn(
      chunk(usage(100)),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'full' } } } }),
      event('compaction/summary', { provider: 'deepseek', model: 'small', usage: usage(60), llmStreamCall: true }),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'retried' } }),
      chunk(usage(200)), message(usage(250)),
    )))
    expect(result.summary.totalTokens).toBe(410)
    expect(result.coverage.missingUsageAttempts).toBe(0)
  })

  it('does not add an interrupted final message again after an aborted finish', () => {
    const result = snapshot(observation(turn(
      chunk(usage(80)),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'aborted' } } }),
      message(),
    )))
    expect(result.summary.totalTokens).toBe(80)
    expect(snapshot(observation(turn(message()))).coverage.missingUsageAttempts).toBe(1)
  })

  it('records a recovery retry whose new request header is followed by no usage chunks', () => {
    const result = snapshot(observation(turn(
      chunk(usage(100)),
      event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'full' } } } }),
      event('compaction/summary', { provider: 'deepseek', model: 'small', usage: usage(60), llmStreamCall: true }),
      event('request/header', { reason: 'series', header: { config: { provider: 'deepseek', model: 'flash' } } }),
    )))
    expect(result.summary.totalTokens).toBe(160)
    expect(result.coverage.missingUsageAttempts).toBe(1)
  })

  it('derives totals only from complete disjoint buckets and never adds reasoning twice', () => {
    const complete = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, reasoningTokens: 8 }
    const result = snapshot(
      observation(turn(message(complete))),
      observation(turn(message({ inputTokens: 100, outputTokens: 20 })), header('missing')),
      observation(turn(message({ inputTokens: 100, outputTokens: 20, totalTokens: 170 })), header('authoritative')),
    )
    expect(result.summary.totalTokens).toBe(335)
    expect(result.coverage.missingUsageAttempts).toBe(1)
  })

  it('counts compaction calls and subagent tokens while excluding injected and child messages', () => {
    const compact = event('compaction/summary', { provider: 'summary', model: 'small', usage: usage(60), llmStreamCall: true, summary: ['secret text'] })
    const noUsage = event('compaction/summary', { provider: 'summary', model: 'small', llmStreamCall: true })
    const template = event('compaction/summary', { provider: 'template', model: 'none' })
    const result = snapshot(
      observation(turn(user(), message(usage()), compact, noUsage, template,
        event('user/message', { source: { kind: 'plugin', plugin: 'compaction' } }),
      )),
      observation(turn(user(), message(usage(50), NOW, 'worker')), header('child', { origin: 'subagent' })),
    )
    expect(result.summary).toMatchObject({ totalTokens: 210, messageCount: 1, sessionCount: 1 })
    expect(result.coverage.missingUsageAttempts).toBe(1)
    expect(result.models).toEqual([
      { provider: 'deepseek', model: 'flash', tokens: 100 },
      { provider: 'summary', model: 'small', tokens: 60 },
      { provider: 'deepseek', model: 'worker', tokens: 50 },
    ])
  })

  it('excludes every inherited event in multi-level forks while retaining inherited route headers', () => {
    const original = turn(user(), message(usage(100)))
    const firstOwn = [event('step/start', { turn: 2, step: 1 }), user(), chunk(usage(50))]
    const secondOwn = [event('step/start', { turn: 3, step: 1 }), user(), chunk(usage(60))]
    const result = snapshot(
      observation(original),
      observation([...original, ...firstOwn], header('fork-1', { isSeeded: true }), original.length),
      observation([...original, ...firstOwn, ...secondOwn], header('fork-2', { isSeeded: true }), original.length + firstOwn.length),
    )
    expect(result.summary).toMatchObject({ totalTokens: 210, sessionCount: 3, messageCount: 3 })
    expect(result.models).toEqual([{ provider: 'deepseek', model: 'flash', tokens: 210 }])
  })

  it('keeps distinct providers for the same model and preserves unattributed exact usage', () => {
    const result = snapshot(
      observation(turn(message(usage(100), NOW, 'flash', 'b'))),
      observation(turn(message(usage(100), NOW, 'flash', 'a')), header('provider-a')),
      observation(turn(message(usage(100), NOW, 'other', 'a')), header('model-other')),
      observation([chunk(usage(30))], header('unknown')),
    )
    expect(result.models).toEqual([
      { provider: 'a', model: 'flash', tokens: 100 },
      { provider: 'a', model: 'other', tokens: 100 },
      { provider: 'b', model: 'flash', tokens: 100 },
      { provider: '', model: '', tokens: 30 },
    ])
    expect(result.summary.mostUsedModel).toEqual(result.models[0])
  })

  it('counts only missing attempts in the selected interval and computes the full current streak', () => {
    const events = Array.from({ length: 40 }, (_, index) => user(NOW - index * 86_400_000))
    events.push(event('step/start', { turn: 1, step: 1 }, NOW - 50 * 86_400_000))
    const source = observation(events)
    const result = snapshot(source)
    expect(result.summary).toMatchObject({ sessionCount: 1, messageCount: 7, activeDays: 7, currentStreak: 40 })
    expect(result.coverage.missingUsageAttempts).toBe(0)
    expect(result.heatmap).toHaveLength(365)
    expect(result.heatmap[0]?.date).toBe('2025-09-09')
    const thirty = aggregateUsage([foldSessionUsage(source, utc)], { days: 30, timeZone: 'UTC' }, NOW, utc, 2)
    expect(thirty.summary.messageCount).toBe(30)
    expect(thirty.coverage.unreadableSessions).toBe(2)
    expect(snapshot(observation([user(NOW - 86_400_000)])).summary.currentStreak).toBe(0)
  })

  it('returns complete zero-filled intervals and detached model objects', () => {
    expect(snapshot().summary).toEqual({
      totalTokens: 0, sessionCount: 0, messageCount: 0, activeDays: 0, currentStreak: 0, mostUsedModel: null,
    })
    const source = foldSessionUsage(observation(turn(message(usage()))), utc)
    const result = aggregateUsage([source], { days: 7, timeZone: 'UTC' }, NOW, utc, 0)
    result.models[0]!.tokens = -1
    expect(aggregateUsage([source], { days: 7, timeZone: 'UTC' }, NOW, utc, 0).summary.totalTokens).toBe(100)
  })
})

describe('local usage calendar', () => {
  it('assigns midnight events using the viewer time zone instead of the Host zone', () => {
    expect(dateOf(dateFormatter('Asia/Shanghai'), Date.parse('2026-09-07T16:00:00Z'))).toBe('2026-09-08')
    expect(dateOf(dateFormatter('America/Los_Angeles'), Date.parse('2026-09-08T06:59:59Z'))).toBe('2026-09-07')
  })

  it('keeps calendar days contiguous through spring and autumn clock changes', () => {
    const ny = dateFormatter('America/New_York')
    expect(dateOf(ny, Date.parse('2026-03-08T06:59:59Z'))).toBe('2026-03-08')
    expect(dateOf(ny, Date.parse('2026-03-08T07:00:00Z'))).toBe('2026-03-08')
    expect(dateOf(ny, Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-01')
    expect(dateOf(ny, Date.parse('2026-11-01T06:30:00Z'))).toBe('2026-11-01')
    expect(shiftDate('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29')
  })
})
