/** Desktop profile plugin management tab. */
import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginManager.module.css'

export interface DesktopPluginInfo {
  readonly name: string
  readonly version: string
  readonly spec: string
  readonly resolution: string
  readonly bundlePatch: string | null
  readonly clientBundle: 'verified' | 'missing' | 'not-declared'
}

export interface DesktopPluginStage {
  readonly token: string
  readonly action: 'install' | 'update' | 'remove'
  readonly packages: readonly DesktopPluginInfo[]
}

export interface PluginManagerInjected {
  readonly list: () => Promise<readonly DesktopPluginInfo[]>
  readonly stage: (request: { action: 'install'; spec: string } | { action: 'update' | 'remove'; name: string }) => Promise<DesktopPluginStage>
  readonly apply: (token: string) => Promise<void>
  readonly cancel: (token: string) => Promise<void>
}

export type PluginManagerProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'desktop'>
  & PluginManagerInjected

/** Manage dependency-backed Desktop profile bundles. */
export function PluginManager({ list, stage, apply, cancel, t }: PluginManagerProps) {
  const [plugins, setPlugins] = useState<readonly DesktopPluginInfo[] | undefined>()
  const [spec, setSpec] = useState('')
  const [pending, setPending] = useState<DesktopPluginStage | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const refresh = (): void => {
    setError(undefined)
    void list().then(setPlugins, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  useEffect(refresh, [])

  const resolveRequest = (request: Parameters<PluginManagerInjected['stage']>[0]): void => {
    setBusy(true)
    setError(undefined)
    void stage(request).then((result) => {
      setPending(result)
      setPlugins(result.packages)
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }
  const cancelPending = (): void => {
    const current = pending
    if (current === undefined) return
    setBusy(true)
    void cancel(current.token).finally(() => {
      setPending(undefined)
      setBusy(false)
      refresh()
    })
  }
  const applyPending = (): void => {
    const current = pending
    if (current === undefined) return
    setBusy(true)
    setError(undefined)
    void apply(current.token).then(
      () => { setBusy(false) },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      },
    )
  }

  return (
    <section className={css.page}>
      <header className={css.heading}>
        <h2>{t('plugins.title')}</h2>
        <p>{t('plugins.description')}</p>
      </header>
      <div className={css.install}>
        <Input
          value={spec}
          disabled={busy || pending !== undefined}
          placeholder={t('plugins.placeholder')}
          aria-label={t('plugins.placeholder')}
          onChange={(event) => { setSpec(event.currentTarget.value) }}
        />
        <Button
          variant="primary"
          disabled={busy || pending !== undefined || spec.trim() === ''}
          onClick={() => { resolveRequest({ action: 'install', spec }) }}
        >
          {t('plugins.install')}
        </Button>
      </div>
      {plugins === undefined ? <p className={css.empty}>{t('plugins.loading')}</p> : (
        <div className={css.list}>
          {plugins.length === 0 && <p className={css.empty}>{t('plugins.empty')}</p>}
          {plugins.map(plugin => (
            <article className={css.row} key={plugin.name}>
              <div>
                <div className={css.name}>{plugin.name}</div>
                <div className={css.meta}>{plugin.version} · {plugin.spec}</div>
                <dl className={css.details}>
                  <dt>{t('plugins.resolution')}</dt><dd>{plugin.resolution}</dd>
                  <dt>{t('plugins.bundle')}</dt><dd>{plugin.bundlePatch ?? t('plugins.notDeclared')}</dd>
                  <dt>{t('plugins.client')}</dt><dd>{t(`plugins.client.${plugin.clientBundle}`)}</dd>
                </dl>
              </div>
              <div className={css.actions}>
                <Button size="sm" variant="outline" disabled={busy || pending !== undefined} onClick={() => { resolveRequest({ action: 'update', name: plugin.name }) }}>{t('plugins.update')}</Button>
                <Button size="sm" variant="ghost" disabled={busy || pending !== undefined} onClick={() => { resolveRequest({ action: 'remove', name: plugin.name }) }}>{t('plugins.remove')}</Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {pending !== undefined && (
        <div className={css.preview} role="status">
          <strong>{t('plugins.resolved')}</strong>
          <span className={css.meta}>{t('plugins.warning')}</span>
          <div className={css.actions}>
            <Button variant="primary" disabled={busy} onClick={applyPending}>{t('plugins.apply')}</Button>
            <Button variant="outline" disabled={busy} onClick={cancelPending}>{t('plugins.cancel')}</Button>
          </div>
        </div>
      )}
      {error !== undefined && <div className={css.error} role="alert">{t('plugins.failed')}: {error}</div>}
    </section>
  )
}
