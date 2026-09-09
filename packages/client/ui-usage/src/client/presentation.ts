/** Pure model-series projection and locale-aware display formatting. */

import type { CSSProperties } from 'react'
import type { UsageModel, UsageSnapshot } from '@deepseek-ai/dsh-api-usage-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/** One chart series; null groups models outside the five largest totals. */
export interface ModelSeries {
  model: UsageModel | null
  tokens: number
  color: number
}

/**
 * Build matching model identities for every chart.
 * @param snapshot - Aggregated usage over the selected date range.
 * @returns All sorted models and the at-most-six chart series.
 */
export function projectModels(snapshot: UsageSnapshot): { models: UsageModel[]; series: ModelSeries[] } {
  const models = [...snapshot.models].sort((left, right) => right.tokens - left.tokens
    || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
  const series: ModelSeries[] = models.slice(0, 5).map((model, color) => ({ model, tokens: model.tokens, color }))
  if (models.length > 5) {
    series.push({ model: null, tokens: models.slice(5).reduce((total, model) => total + model.tokens, 0), color: 5 })
  }
  return { models, series }
}

/**
 * Compare model routes without conflating equal names from different providers.
 * @param left - First model route.
 * @param right - Second model route.
 * @returns Whether both attribution fields match.
 */
export function sameModel(left: UsageModel, right: UsageModel): boolean {
  return left.model === right.model && left.provider === right.provider
}

/**
 * Select the shared semantic color for one chart series.
 * @param index - Rank of the model; ranks after five share the Other color.
 * @returns Component-local CSS custom property.
 */
export function seriesStyle(index: number): CSSProperties {
  return { '--usage-series': `var(--dsw-alias-chart-${index < 5 ? String(index + 1) : 'other'})` } as CSSProperties
}

/**
 * Name a model route, including missing durable attribution.
 * @param model - Recorded provider and model.
 * @param t - Usage dictionary translator.
 * @returns Localized label with the original recorded names.
 */
export function modelLabel(model: UsageModel, t: TranslateNS<'settings.usage'>): string {
  return t('modelName', {
    model: model.model || t('unknownModel'), provider: model.provider || t('unknownProvider'),
  })
}

/**
 * Format a date-only value without converting it to a different local day.
 * @param date - Calendar date supplied by the Host.
 * @param locale - Locale selected by the usage dictionary.
 * @returns Localized month and day.
 */
export function displayDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`))
}
