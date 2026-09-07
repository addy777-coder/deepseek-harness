/** Focused desktop title bar rendered above the shared AppFrame. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TitleBar.module.css'

export interface DesktopTitleBarInjected {
  readonly kind: 'main' | 'task'
  readonly openMain: () => void
  readonly openSession: (sessionId: string) => void
  readonly newTask: () => void
}

export type DesktopTitleBarProps = PropsRuntime<'shell.titlebar'>
  & PropsLocale<'desktop'>
  & DesktopTitleBarInjected

/** Desktop caption content; native caption buttons occupy the reserved right rail. */
export function DesktopTitleBar({ kind, openMain, openSession, newTask, useSessions, t }: DesktopTitleBarProps) {
  const current = useSessions(state => state.current)
  const title = useSessions(state => current === undefined ? undefined : state.byId[current]?.displayTitle)
  const blank = useSessions(state => current === undefined || state.byId[current]?.blank !== false)
  return (
    <header className={css.bar}>
      <div className={css.identity}>
        <span className={css.mark} aria-hidden="true">{t('brand.mark')}</span>
        <span className={css.title}>{kind === 'task' ? title ?? t('brand') : t('brand')}</span>
      </div>
      <div className={css.actions}>
        {kind === 'main' ? (
          <>
            <button className={css.action} type="button" onClick={newTask}>{t('newTask')}</button>
            <button
              className={css.action}
              type="button"
              disabled={blank || current === undefined}
              onClick={() => { if (current !== undefined) openSession(current) }}
            >
              {t('openWindow')}
            </button>
          </>
        ) : (
          <button className={css.action} type="button" onClick={openMain}>{t('openMain')}</button>
        )}
      </div>
      <div aria-hidden="true" />
    </header>
  )
}
