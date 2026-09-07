/** Models-page selector for the global image-recognition route. */

import { useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ImageRecognitionCardController } from './image-recognition-controller.ts'
import type { en } from './locales.ts'
import { EditorFooter } from './EditorFooter.tsx'
import styles from './ModelsSection.module.css'

/** Props of {@link ImageRecognitionCard}. */
export interface ImageRecognitionCardProps {
  controller: ImageRecognitionCardController
  t: (key: keyof typeof en) => string
}

/** Render the global exact-route selector over explicitly image-capable models. */
export function ImageRecognitionCard({ controller, t }: ImageRecognitionCardProps): ReactNode {
  const state = useSyncExternalStore(
    listener => controller.store.subscribe(listener),
    () => controller.store.getSnapshot(),
  )
  useEffect(() => { controller.ensureCatalog() }, [controller])
  if (!state.available) return null
  return (
    <section className={styles['recognitionCard']} aria-label={t('recognitionTitle')}>
      <div className={styles['recognitionHeading']}>
        <span className={styles['recognitionTitle']}>{t('recognitionTitle')}</span>
        <span className={styles['rowTag']}>{t('visionTag')}</span>
      </div>
      <p className={styles['recognitionDescription']}>{t('recognitionDescription')}</p>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('recognitionModel')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={state.selectedKey}
          aria-label={t('recognitionModel')}
          disabled={!state.writable || state.saving || state.catalogStatus === 'loading'}
          onChange={(event) => { controller.select(event.target.value) }}
        >
          <option value="">{t('recognitionNone')}</option>
          {state.candidates.map(candidate => (
            <option key={candidate.key} value={candidate.key} disabled={!candidate.available}>
              {candidate.available
                ? `${candidate.providerName} · ${candidate.modelName}`
                : `${candidate.provider}/${candidate.model} · ${t('recognitionUnavailable')}`}
            </option>
          ))}
        </select>
      </label>
      {state.catalogStatus === 'loading'
        ? <p className={styles['notice']} role="status">{t('recognitionLoading')}</p>
        : null}
      {state.catalogStatus === 'error'
        ? (
          <p className={styles['error']} role="alert">
            {t('recognitionLoadFailed')}{' '}
            <button type="button" className={styles['linkButton']} onClick={() => { controller.retryCatalog() }}>
              {t('retry')}
            </button>
          </p>
        )
        : null}
      {state.catalogPartial ? <p className={styles['notice']}>{t('recognitionPartial')}</p> : null}
      {state.invalid ? <p className={styles['error']}>{t('recognitionInvalid')}</p> : null}
      {state.failed ? <p className={styles['error']}>{t('recognitionSaveFailed')}</p> : null}
      {state.conflicted ? <p className={styles['error']}>{t('recognitionConflict')}</p> : null}
      <EditorFooter
        t={t}
        busy={state.saving}
        submitDisabled={!state.writable || !state.dirty || state.invalid || state.saving}
        submitLabelKey="recognitionSave"
        submitBusyLabelKey="recognitionSaving"
        onCancel={() => { controller.discard() }}
        onSubmit={() => { controller.save() }}
      />
    </section>
  )
}
