/** Focused desktop title bar rendered above the shared AppFrame. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TitleBar.module.css'

export interface DesktopTitleBarInjected {
  readonly newTask: () => void
}

export type DesktopTitleBarProps = PropsRuntime<'shell.titlebar'>
  & PropsLocale<'desktop'>
  & DesktopTitleBarInjected

/** Desktop caption content; native caption buttons occupy the reserved right rail. */
export function DesktopTitleBar({ newTask, t }: DesktopTitleBarProps) {
  return (
    <header className={css.bar}>
      <div className={css.identity}>
        <span className={css.mark} aria-hidden="true">{t('brand.mark')}</span>
        <span className={css.title}>{t('brand')}</span>
      </div>
      <div className={css.actions}>
        <button className={css.action} type="button" onClick={newTask}>{t('newTask')}</button>
      </div>
      <div aria-hidden="true" />
    </header>
  )
}
