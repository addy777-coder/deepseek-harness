/** DSH Desktop occupants for the shared sidebar brand slots. */
import type {
  SidebarBrandMarkOwnerProps,
  SidebarBrandNameOwnerProps,
} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopBrand.module.css'

/** Render the independent DSH letter mark at the size requested by the sidebar. */
export function DesktopBrandMark({ size, t }: SidebarBrandMarkOwnerProps & PropsLocale<'desktop'>) {
  return (
    <span
      className={css.mark}
      style={{ width: size, height: size, borderRadius: Math.max(6, Math.round(size / 3)) }}
      aria-hidden="true"
    >
      {t('brand.mark')}
    </span>
  )
}

/** Render the Desktop product name beside its independently slotted mark. */
export function DesktopBrandName({ t }: SidebarBrandNameOwnerProps & PropsLocale<'desktop'>) {
  return <span className={css.name}>{t('brand')}</span>
}
