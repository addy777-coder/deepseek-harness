/** Settings usage dashboard; the injected Client model owns query state. */

import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import type { UsageClientSnapshot } from '@deepseek-ai/dsh-api-usage-controller/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ActivityHeatmap, DailyTrend, ModelUsage } from './UsageCharts.tsx'
import { modelLabel } from './presentation.ts'
import type {} from './locales.ts'
import css from './UsageSection.module.css'

/** Registration-side commands and the controller-owned observable. */
export interface UsageSectionInjected {
  hooks: { usage: HostObservable<UsageClientSnapshot> }
  /**
   * Query the selected range using the current browser time zone.
   * @param days - Inclusive calendar range ending today.
   * @returns Settlement after the Client publishes success or failure.
   */
  load: (days: 7 | 30) => Promise<void>
  /**
   * Refresh the selected range; errors are published through the observable.
   * @returns Settlement after the Client publishes success or failure.
   */
  refresh: () => Promise<void>
}

/** Props bound by Slots for the usage settings contribution. */
export type UsageSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.usage'> & InjectFace<UsageSectionInjected>

/**
 * Render usage totals and charts with loading, partial-data and retry states.
 * @param props - Framework-bound snapshot, translation and query commands.
 * @returns Read-only usage dashboard.
 */
export function UsageSection({ useUsage, load, refresh, t }: UsageSectionProps) {
  const state = useUsage(value => value)
  const selectedDays = state.request?.days ?? 30
  const initialDays = useRef(selectedDays)
  const data = state.data
  const busy = state.status === 'idle' || state.status === 'loading'
  const number = new Intl.NumberFormat(t('formatLocale'))
  const compact = new Intl.NumberFormat(t('formatLocale'), { notation: 'compact', maximumFractionDigits: 1 })
  const percent = new Intl.NumberFormat(t('formatLocale'), { style: 'percent', maximumFractionDigits: 1 })

  useEffect(() => { void load(initialDays.current) }, [load])

  return (
    <div className={css.section} data-usage-statistics aria-busy={busy}>
      <header className={css.header}><h2>{t('title')}</h2><p>{t('intro')}</p></header>
      <div className={css.toolbar}>
        <span className={css.rangeLabel}>{t('range')}</span>
        <div className={css.controls}>
          <div className={css.range} role="group" aria-label={t('range')}>
            {([7, 30] as const).map(days => (
              <button key={days} type="button" aria-pressed={selectedDays === days}
                className={clsx(css.button, selectedDays === days && css.selected)}
                onClick={() => { void load(days) }}>{t(days === 7 ? 'sevenDays' : 'thirtyDays')}</button>
            ))}
          </div>
          <button type="button" className={css.refresh} onClick={() => { void refresh() }} disabled={busy}>
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" aria-hidden="true"><path d="M13 5a5.5 5.5 0 1 0 .4 5M13 2v3H10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" /></svg>
            {t('refresh')}
          </button>
        </div>
      </div>
      {busy ? <p className={css.status} role="status">{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure} role="alert"><p>{t(data === null ? 'error' : 'stale')}</p>
          <button type="button" className={css.refresh} onClick={() => { void refresh() }}>{t('retry')}</button></div>
      ) : null}
      {data !== null ? (
        <>
          <p className={css.caption}>{t('displayedRange', { from: data.from, to: data.to })}</p>
          <dl className={css.metrics} data-usage-summary>
            {([
              ['totalTokens', compact.format(data.summary.totalTokens)],
              ['sessions', number.format(data.summary.sessionCount)],
              ['messages', number.format(data.summary.messageCount)],
              ['activeDays', number.format(data.summary.activeDays)],
              ['streak', number.format(data.summary.currentStreak)],
            ] as const).map(([label, value]) => (
              <div key={label} className={css.metric}><dt>{t(label)}</dt><dd title={label === 'totalTokens' ? number.format(data.summary.totalTokens) : undefined}>{value}</dd></div>
            ))}
            <div className={clsx(css.metric, css.modelMetric)}><dt>{t('mostUsed')}</dt>
              <dd>{data.summary.mostUsedModel === null ? t('noModel') : modelLabel(data.summary.mostUsedModel, t)}</dd>
              {data.summary.mostUsedModel !== null ? <span className={css.caption}>{t('share', { value: percent.format(data.summary.totalTokens === 0 ? 0 : data.summary.mostUsedModel.tokens / data.summary.totalTokens) })}</span> : null}
            </div>
          </dl>
          {data.summary.messageCount === 0 && data.summary.totalTokens === 0 ? <p className={css.empty}>{t('empty')}</p> : null}
          {data.coverage.unreadableSessions > 0 ? <p className={css.warning} role="status">{t('partial', { count: number.format(data.coverage.unreadableSessions) })}</p> : null}
          {data.coverage.missingUsageAttempts > 0 ? <p className={css.warning} role="status">{t('missingUsage', { count: number.format(data.coverage.missingUsageAttempts) })}</p> : null}
          <ActivityHeatmap data={data} t={t} />
          <DailyTrend data={data} t={t} />
          <ModelUsage data={data} t={t} />
          <footer className={css.footer}>
            <p>{t('scope')}</p>
            <div><span>{t('timeZone', { value: data.timeZone })}</span><span>{t('updated', { time: new Intl.DateTimeFormat(t('formatLocale'), { dateStyle: 'medium', timeStyle: 'short', timeZone: data.timeZone }).format(data.generatedAt) })}</span></div>
          </footer>
        </>
      ) : null}
    </div>
  )
}
