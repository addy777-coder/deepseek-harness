import { describe, expect, it } from 'vitest'
import type { UsageSnapshot } from '@deepseek-ai/dsh-api-usage-controller/types'
import { displayDate, projectModels, sameModel } from '../src/client/presentation.ts'

describe('usage chart projection', () => {
  it('groups only chart overflow while retaining every provider/model row', () => {
    const models = Array.from({ length: 7 }, (_, index) => ({ provider: 'provider', model: String(index), tokens: 7 - index }))
    const result = projectModels({ models: [...models].reverse() } as UsageSnapshot)
    expect(result.models).toEqual(models)
    expect(result.series).toHaveLength(6)
    expect(result.series[5]).toEqual({ model: null, tokens: 3, color: 5 })
    expect(sameModel(models[0]!, { ...models[0]!, provider: 'other' })).toBe(false)
  })

  it('uses provider and model names to stabilize equal token totals', () => {
    const models = [
      { provider: 'b', model: 'a', tokens: 1 },
      { provider: 'a', model: 'b', tokens: 1 },
      { provider: 'a', model: 'a', tokens: 1 },
    ]
    expect(projectModels({ models } as UsageSnapshot).models).toEqual([models[2], models[1], models[0]])
  })

  it('formats a date-only Host day without shifting its date in the local time zone', () => {
    expect(displayDate('2026-01-01', 'en')).toBe('Jan 1')
  })
})
