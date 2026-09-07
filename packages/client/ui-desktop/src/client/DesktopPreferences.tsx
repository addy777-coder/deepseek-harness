/** General-settings row for global shortcut and Windows login launch. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopPreferences.module.css'

export interface DesktopPreferencesValue {
  readonly globalShortcut: string | null
  readonly shortcutRegistered: boolean
  readonly launchAtLogin: boolean
  readonly launchAtLoginAvailable: boolean
}

export interface DesktopPreferencesInjected {
  readonly read: () => Promise<DesktopPreferencesValue>
  readonly write: (request:
    | { readonly key: 'globalShortcut'; readonly value: string | null }
    | { readonly key: 'launchAtLogin'; readonly value: boolean }) => Promise<DesktopPreferencesValue>
}

export type DesktopPreferencesProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'desktop'>
  & DesktopPreferencesInjected

/** Render and persist Desktop-main preferences. */
export function DesktopPreferences({ read, write, t }: DesktopPreferencesProps) {
  const [value, setValue] = useState<DesktopPreferencesValue | undefined>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void read().then((next) => {
      setValue(next)
      setDraft(next.globalShortcut ?? '')
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [])

  const mutate = (request: Parameters<DesktopPreferencesInjected['write']>[0]): void => {
    setBusy(true)
    setError(undefined)
    void write(request).then((next) => {
      setValue(next)
      setDraft(next.globalShortcut ?? '')
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }

  return (
    <section className={css.row}>
      <h3 className={css.title}>{t('preferences.title')}</h3>
      <span className={css.label}>{t('preferences.shortcut')}</span>
      <div className={css.shortcut}>
        <Input
          value={draft}
          disabled={busy || value === undefined}
          aria-label={t('preferences.shortcut')}
          placeholder={t('preferences.shortcutPlaceholder')}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
        />
        <Button size="sm" variant="primary" disabled={busy || draft.trim() === ''} onClick={() => { mutate({ key: 'globalShortcut', value: draft }) }}>{t('preferences.save')}</Button>
        <Button size="sm" variant="outline" disabled={busy || value?.globalShortcut === null} onClick={() => { mutate({ key: 'globalShortcut', value: null }) }}>{t('preferences.disable')}</Button>
      </div>
      {value?.globalShortcut !== null && value?.shortcutRegistered === false && <span className={css.warning}>{t('preferences.conflict')}</span>}
      <label className={css.toggle}>
        <input
          type="checkbox"
          checked={value?.launchAtLogin ?? false}
          disabled={busy || value?.launchAtLoginAvailable !== true}
          onChange={(event) => { mutate({ key: 'launchAtLogin', value: event.currentTarget.checked }) }}
        />
        {t('preferences.launch')}
      </label>
      {value?.launchAtLoginAvailable === false && <span className={css.label}>{t('preferences.launchUnavailable')}</span>}
      {error !== undefined && <span className={css.error} role="alert">{error}</span>}
    </section>
  )
}
