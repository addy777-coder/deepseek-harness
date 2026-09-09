/** Accessible SVG charts derived from one usage snapshot and shared series. */

import { useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { UsageSnapshot } from '@deepseek-ai/dsh-api-usage-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { displayDate, modelLabel, projectModels, sameModel, seriesStyle } from './presentation.ts'
import css from './UsageSection.module.css'

interface ChartProps {
  data: UsageSnapshot
  t: TranslateNS<'settings.usage'>
}

/**
 * Render a year of user activity with one tab stop and arrow-key date navigation.
 * @param props - Usage snapshot and localized chart copy.
 * @returns Heatmap with focused-date feedback.
 */
export function ActivityHeatmap({ data, t }: ChartProps) {
  const helpId = useId()
  const [focused, setFocused] = useState(data.heatmap.length - 1)
  const [hint, setHint] = useState('')
  const cells = useRef<Array<SVGRectElement | null>>([])
  const first = data.heatmap[0]
  const offset = first === undefined ? 0 : new Date(`${first.date}T00:00:00Z`).getUTCDay()
  const columns = Math.ceil((offset + data.heatmap.length) / 7)
  const maximum = Math.max(1, ...data.heatmap.map(day => day.messages))
  const number = new Intl.NumberFormat(t('formatLocale'))
  return (
    <section className={css.chartCard}>
      <div className={css.chartHeading}>
        <div><h3>{t('heatmap')}</h3><span className={css.caption}>{t('heatmapPeriod')}</span></div>
        <div className={css.heatLegend} aria-hidden="true">
          <span>{t('less')}</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={css.heatSwatch} style={{ '--usage-intensity': `${level * 25}%` } as CSSProperties} />
          ))}
          <span>{t('more')}</span>
        </div>
      </div>
      <p id={helpId} className={css.srOnly}>{t('heatmapHelp')}</p>
      <svg viewBox={`0 0 ${Math.max(columns, 1) * 12} 84`} className={css.heatmap}
        role="group" aria-label={t('heatmap')} aria-describedby={helpId}>
        {data.heatmap.map((day, index) => {
          const label = t('activity', { date: day.date, count: number.format(day.messages) })
          const intensity = day.messages === 0 ? 0 : Math.max(25, Math.ceil(day.messages / maximum * 4) * 25)
          return (
            <rect key={day.date} ref={(cell) => { cells.current[index] = cell }}
              x={Math.floor((index + offset) / 7) * 12} y={(index + offset) % 7 * 12}
              width={9} height={9} rx={2} className={css.heatCell}
              style={{ '--usage-intensity': `${intensity}%` } as CSSProperties}
              tabIndex={index === focused ? 0 : -1} role="img" aria-label={label}
              onMouseEnter={() => { setHint(label) }} onMouseLeave={() => { setHint('') }}
              onFocus={() => { setFocused(index); setHint(label) }} onBlur={() => { setHint('') }}
              onKeyDown={(event) => {
                let next: number
                switch (event.key) {
                  case 'ArrowLeft': next = index - 7; break
                  case 'ArrowRight': next = index + 7; break
                  case 'ArrowUp': next = index - 1; break
                  case 'ArrowDown': next = index + 1; break
                  case 'Home': next = 0; break
                  case 'End': next = data.heatmap.length - 1; break
                  default: return
                }
                event.preventDefault()
                cells.current[Math.max(0, Math.min(data.heatmap.length - 1, next))]?.focus()
              }}>
              <title>{label}</title>
            </rect>
          )
        })}
      </svg>
      <p className={css.chartHint} aria-live="polite">{hint || '\u00a0'}</p>
    </section>
  )
}

/**
 * Render daily token stacks and a complete expandable daily table.
 * @param props - Usage snapshot and localized chart copy.
 * @returns Shared-color daily bar chart and accessible data.
 */
export function DailyTrend({ data, t }: ChartProps) {
  const [hint, setHint] = useState('')
  const { series } = projectModels(data)
  const number = new Intl.NumberFormat(t('formatLocale'))
  const compact = new Intl.NumberFormat(t('formatLocale'), { notation: 'compact', maximumFractionDigits: 1 })
  const maximum = Math.max(1, ...data.daily.map(day => day.tokens))
  const plotWidth = 480
  const step = plotWidth / data.days
  return (
    <section className={css.chartCard}>
      <h3>{t('trend')}</h3>
      <svg viewBox="0 0 540 214" className={css.trend} role="group" aria-label={t('trend')}>
        {[0, 0.5, 1].map(fraction => (
          <g key={fraction} aria-hidden="true">
            <line x1={48} x2={528} y1={178 - fraction * 154} y2={178 - fraction * 154} className={css.gridLine} />
            <text x={40} y={182 - fraction * 154} textAnchor="end" className={css.axisText}>{compact.format(maximum * fraction)}</text>
          </g>
        ))}
        {data.daily.map((day, dayIndex) => {
          let stacked = 0
          return (
            <g key={day.date}>
              {series.map((item) => {
                const tokens = day.models.filter(model => item.model === null
                  ? !series.some(candidate => candidate.model !== null && sameModel(candidate.model, model))
                  : sameModel(item.model, model)).reduce((total, model) => total + model.tokens, 0)
                const height = tokens / maximum * 154
                stacked += height
                if (tokens === 0) return null
                const name = item.model === null ? t('other') : modelLabel(item.model, t)
                const label = t('chartPoint', { date: day.date, model: name, count: number.format(tokens) })
                return (
                  <rect key={item.color} x={48 + dayIndex * step + step * 0.17} y={178 - stacked}
                    width={step * 0.66} height={height} rx={1} className={css.bar} style={seriesStyle(item.color)}
                    tabIndex={0} role="img" aria-label={label}
                    onMouseEnter={() => { setHint(label) }} onMouseLeave={() => { setHint('') }}
                    onFocus={() => { setHint(label) }} onBlur={() => { setHint('') }}>
                    <title>{label}</title>
                  </rect>
                )
              })}
              {dayIndex === 0 || dayIndex === data.daily.length - 1 || dayIndex % (data.days === 7 ? 2 : 7) === 0 ? (
                <text x={48 + dayIndex * step + step / 2} y={201} textAnchor="middle" className={css.axisText} aria-hidden="true">
                  {displayDate(day.date, t('formatLocale'))}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      <p className={css.chartHint} aria-live="polite">{hint || '\u00a0'}</p>
      <ul className={css.legend}>
        {series.map(item => (
          <li key={item.color}><span className={css.dot} style={seriesStyle(item.color)} aria-hidden="true" />
            <span>{item.model === null ? t('other') : modelLabel(item.model, t)}</span></li>
        ))}
      </ul>
      <details className={css.dailyData}>
        <summary>{t('dailyData')}</summary>
        <div className={css.tableScroll}>
          <table>
            <thead><tr><th scope="col">{t('date')}</th><th scope="col">{t('totalTokens')}</th><th scope="col">{t('messages')}</th><th scope="col">{t('sessions')}</th></tr></thead>
            <tbody>{data.daily.map(day => (
              <tr key={day.date}><th scope="row">{day.date}</th><td>{number.format(day.tokens)}</td><td>{number.format(day.messages)}</td><td>{number.format(day.sessions)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

/**
 * Render model shares and every provider/model total, including zero values.
 * @param props - Usage snapshot and localized chart copy.
 * @returns Model donut with the complete model list.
 */
export function ModelUsage({ data, t }: ChartProps) {
  const [hint, setHint] = useState('')
  const { models, series } = projectModels(data)
  const number = new Intl.NumberFormat(t('formatLocale'))
  const compact = new Intl.NumberFormat(t('formatLocale'), { notation: 'compact', maximumFractionDigits: 1 })
  const percent = new Intl.NumberFormat(t('formatLocale'), { style: 'percent', maximumFractionDigits: 1 })
  let offset = 0
  return (
    <section className={css.chartCard} data-usage-models>
      <h3>{t('modelUsage')}</h3>
      <div className={css.modelLayout}>
        <div className={css.donutWrap}>
          <svg viewBox="0 0 190 190" className={css.donut} role="group" aria-label={t('modelUsage')}>
            <circle cx={95} cy={95} r={72} className={css.donutTrack} />
            {series.map((item) => {
              const share = data.summary.totalTokens === 0 ? 0 : item.tokens / data.summary.totalTokens
              const start = offset
              offset += share * 100
              if (share === 0) return null
              const name = item.model === null ? t('other') : modelLabel(item.model, t)
              const label = t('modelPoint', { model: name, count: number.format(item.tokens), share: percent.format(share) })
              return (
                <circle key={item.color} cx={95} cy={95} r={72} pathLength={100}
                  strokeDasharray={`${share * 100} ${100 - share * 100}`} strokeDashoffset={-start}
                  transform="rotate(-90 95 95)" className={css.donutSegment} style={seriesStyle(item.color)}
                  tabIndex={0} role="img" aria-label={label}
                  onMouseEnter={() => { setHint(label) }} onMouseLeave={() => { setHint('') }}
                  onFocus={() => { setHint(label) }} onBlur={() => { setHint('') }}>
                  <title>{label}</title>
                </circle>
              )
            })}
            <text x={95} y={98} textAnchor="middle" className={css.donutValue}>{compact.format(data.summary.totalTokens)}</text>
            <text x={95} y={118} textAnchor="middle" className={css.axisText}>{t('totalTokens')}</text>
          </svg>
        </div>
        <ul className={css.modelList}>
          {models.map((model, index) => (
            <li key={JSON.stringify([model.provider, model.model])}>
              <span className={css.dot} style={seriesStyle(index)} aria-hidden="true" />
              <div className={css.modelDetail}><span>{modelLabel(model, t)}</span><span className={css.caption}>{t('tokenCount', { count: number.format(model.tokens) })}</span></div>
              <span className={css.modelShare}>
                {percent.format(data.summary.totalTokens === 0 ? 0 : model.tokens / data.summary.totalTokens)}
              </span>
            </li>
          ))}
          {models.length === 0 ? <li className={css.caption}>{t('noModel')}</li> : null}
        </ul>
      </div>
      <p className={css.chartHint} aria-live="polite">{hint || '\u00a0'}</p>
    </section>
  )
}
