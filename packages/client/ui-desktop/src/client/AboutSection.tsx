/** About/update settings page for the Desktop main window. */
import { useState } from 'react'
import {
  Button,
  IconDownloadOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './AboutSection.module.css'

/** Update wire shape mirrored from the Desktop main process. */
export interface DesktopUpdateProgress {
  readonly percent: number
  readonly transferred: number
  readonly total: number
}

export interface DesktopUpdateState {
  readonly phase:
    | 'unsupported' | 'idle' | 'checking' | 'available' | 'up-to-date'
    | 'downloading' | 'downloaded' | 'installing' | 'error'
  readonly currentVersion: string
  readonly latestVersion: string | null
  readonly releaseName: string | null
  readonly releaseNotes: string | null
  readonly progress: DesktopUpdateProgress | null
  readonly message: string | null
}

/** Update commands and the main-process-owned live state. */
export interface AboutSectionInjected {
  /** Live update state owned by the Desktop main process. */
  hooks: { update: ObservableSnapshot<DesktopUpdateState> }
  /** Query the update feed; the pushed state drives the UI. */
  checkForUpdate: () => Promise<DesktopUpdateState>
  /** Download the available update; the pushed state shows progress. */
  downloadUpdate: () => Promise<DesktopUpdateState>
  /** Install the downloaded update and restart the app. */
  installUpdate: () => Promise<DesktopUpdateState>
  /** Cancel the in-flight download; the pushed state returns to available. */
  cancelUpdate: () => Promise<DesktopUpdateState>
  /** Open the repository releases page in the system browser. */
  openReleases: () => Promise<void>
}

/** Props bound by Slots for the About settings section. */
export type AboutSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'desktop'>
  & InjectFace<AboutSectionInjected>

function formatBytes(value: number): string {
  return `${(value / 1048576).toFixed(1)} MB`
}

/** Render the installed version and drive the in-app update lifecycle. */
export function AboutSection({
  useUpdate, checkForUpdate, downloadUpdate, installUpdate, cancelUpdate, openReleases, t,
}: AboutSectionProps) {
  const update = useUpdate(value => value)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const busy = running || cancelling

  const run = (action: () => Promise<unknown>, setPending: (pending: boolean) => void = setRunning): void => {
    setPending(true)
    setError(undefined)
    void action().then(
      () => { setPending(false) },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setPending(false)
      },
    )
  }

  const phase = update.phase
  const failure = error ?? (phase === 'error' ? update.message : null)
  const progress = update.progress
  const canCheck = phase === 'idle' || phase === 'up-to-date' || phase === 'error' || phase === 'unsupported'
  const showNotes = (phase === 'available' || phase === 'downloading' || phase === 'downloaded' || phase === 'installing')
    && update.releaseNotes !== null

  return (
    <section className={css.page}>
      <header className={css.heading}><h2>{t('about.title')}</h2></header>
      <div className={css.card}>
        <dl className={css.versions}>
          <dt>{t('about.current')}</dt>
          <dd>{update.currentVersion}</dd>
          {phase === 'up-to-date' && update.latestVersion !== null ? (
            <>
              <dt>{t('about.latest')}</dt>
              <dd>{update.latestVersion}</dd>
            </>
          ) : null}
        </dl>
        {phase === 'checking' ? <p className={css.status} role="status">{t('about.checking')}</p> : null}
        {phase === 'available' && update.latestVersion !== null ? (
          <p className={css.status} role="status">{t('about.available')} {update.latestVersion}</p>
        ) : null}
        {phase === 'up-to-date' ? (
          <p className={css.status} role="status">{t('about.upToDate')}</p>
        ) : null}
        {phase === 'downloading' ? (
          <p className={css.status} role="status">{t('about.downloading')}</p>
        ) : null}
        {phase === 'downloaded' ? (
          <p className={css.status} role="status">{t('about.downloaded')}</p>
        ) : null}
        {phase === 'installing' ? (
          <p className={css.status} role="status">{t('about.installing')}</p>
        ) : null}
        {phase === 'unsupported' ? (
          <div className={css.status} role="status">
            <p>{t('about.unsupported')}</p>
            <p>{t('about.unsupportedHint')}</p>
          </div>
        ) : null}
        {phase === 'downloading' && progress !== null ? (
          <div className={css.progress} aria-label={t('about.progress')}>
            <progress className={css.bar} max={100} value={progress.percent} />
            <span className={css.meta}>
              {String(Math.round(progress.percent))}% · {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
            </span>
          </div>
        ) : null}
        {showNotes ? (
          <div className={css.notes}>
            <span className={css.meta}>{t('about.releaseNotes')}</span>
            {update.releaseName !== null && <strong>{update.releaseName}</strong>}
            <div className={css.noteBody}>{update.releaseNotes}</div>
          </div>
        ) : null}
        <div className={css.actions}>
          {canCheck ? (
            <Button icon={<IconRefreshOutline16 size={16} />} disabled={busy} onClick={() => { run(checkForUpdate) }}>
              {t('about.check')}
            </Button>
          ) : null}
          {phase === 'available' ? (
            <Button variant="primary" icon={<IconDownloadOutline16 size={16} />} disabled={busy} onClick={() => { run(downloadUpdate) }}>
              {t('about.download')}
            </Button>
          ) : null}
          {phase === 'downloading' ? (
            <Button variant="outline" disabled={cancelling} onClick={() => { run(cancelUpdate, setCancelling) }}>
              {t('about.cancelDownload')}
            </Button>
          ) : null}
          {phase === 'downloaded' ? (
            <Button variant="primary" disabled={busy} onClick={() => { run(installUpdate) }}>
              {t('about.install')}
            </Button>
          ) : null}
          <Button variant="outline" icon={<IconRightUpOutline16 size={16} />} disabled={busy} onClick={() => { void openReleases() }}>
            {t('about.releases')}
          </Button>
        </div>
        {failure !== null ? <div className={css.error} role="alert">{t('about.error')}: {failure}</div> : null}
      </div>
    </section>
  )
}
