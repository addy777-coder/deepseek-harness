/** VPN settings form keeps secret drafts local and renders controller-owned status. */

import { useEffect, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SaveVpnRequest, VpnClientSnapshot } from '@deepseek-ai/dsh-api-vpn-controller/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import { vpnFailureText } from './failure.ts'
import css from './VpnSection.module.css'

/** Controller commands and observable supplied by the VPN settings registrant. */
export interface VpnSectionInjected {
  /** Public VPN state; no profile contents or saved password are present. */
  hooks: { vpn: ObservableSnapshot<VpnClientSnapshot> }
  /**
   * Refresh settings and connection status.
   * @returns Settlement after the controller publishes success or failure.
   */
  load: () => Promise<void>
  /**
   * Save an import or credentials and start the connection.
   * @param request - Browser-read file contents and locally entered credentials.
   * @returns Whether settings were saved; connection errors appear in the snapshot.
   */
  saveAndConnect: (request: SaveVpnRequest) => Promise<boolean>
  /**
   * Connect using the persisted settings.
   * @returns Settlement after the controller publishes the operation result.
   */
  connect: () => Promise<void>
  /**
   * Stop the active connection or connection attempt.
   * @returns Settlement after the controller publishes the stopped state.
   */
  disconnect: () => Promise<void>
}

/** Props bound by Slots for the VPN settings section. */
export type VpnSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.vpn'> & InjectFace<VpnSectionInjected>

/**
 * Render file import, write-only credentials, startup preference, and connection controls.
 * @param props - Public controller state, commands, and localized copy.
 * @returns The VPN settings section.
 */
export function VpnSection({ useVpn, load, saveAndConnect, connect, disconnect, t }: VpnSectionProps) {
  const snapshot = useVpn(value => value)
  const view = snapshot.data
  const [username, setUsername] = useState(view?.username ?? '')
  const [password, setPassword] = useState('')
  const [autoConnect, setAutoConnect] = useState(view?.autoConnect ?? true)
  const [profile, setProfile] = useState<File | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dirty, setDirty] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const profileInput = useRef<HTMLInputElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const isMounted = (): boolean => mounted.current
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const busy = submitting || snapshot.busy
  const disabled = busy || loading || view === null || !view.supported
  const connection = view?.connection ?? 'unconfigured'
  const active = connection === 'connected' || connection === 'connecting' || connection === 'reconnecting'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (view !== null && !dirty) {
      setUsername(view.username)
      setAutoConnect(view.autoConnect)
    }
  }, [view, dirty])

  const clearFiles = (): void => {
    setProfile(null)
    setFiles([])
    if (profileInput.current) profileInput.current.value = ''
    if (filesInput.current) filesInput.current.value = ''
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setFailure(null)
    try { await action() }
    catch { if (isMounted()) setFailure(t('operationFailed')) }
  }

  const save = async (): Promise<void> => {
    setFailure(null)
    if (profile === null && view?.profileName === null) { setFailure(t('profileRequired')); return }
    if (profile !== null && !profile.name.toLowerCase().endsWith('.ovpn')) { setFailure(t('profileExtension')); return }
    if (files.length > 0 && profile === null) { setFailure(t('referencesNeedProfile')); return }
    if (!username.trim() || (!password && !view?.passwordConfigured)) { setFailure(t('credentialsRequired')); return }
    setSubmitting(true)
    try {
      let imported: Pick<SaveVpnRequest, 'profile' | 'files'> = {}
      if (profile !== null) {
        try {
          const read = async (file: File) => ({ name: file.name, content: await file.text() })
          const [profileFile, references] = await Promise.all([read(profile), Promise.all(files.map(read))])
          imported = { profile: profileFile, files: references }
        } catch {
          if (isMounted()) setFailure(t('fileReadFailed'))
          return
        }
      }
      if (!isMounted()) return
      const saved = await saveAndConnect({
        ...imported, username: username.trim(), autoConnect,
        ...password.length > 0 ? { password } : {},
      })
      if (saved && isMounted()) {
        setPassword('')
        clearFiles()
        setDirty(false)
      }
    } catch {
      if (isMounted()) setFailure(t('operationFailed'))
    } finally {
      if (isMounted()) setSubmitting(false)
    }
  }

  const error = failure ?? (snapshot.error ? vpnFailureText(snapshot.error, t)
    : view?.failure ? vpnFailureText(view.failure.code, t) : null)

  return (
    <section className={css.section} data-vpn-settings aria-busy={loading || busy}>
      <header className={css.header}><h2>{t('title')}</h2><p>{t('intro')}</p></header>
      {loading ? <p className={css.loading} role="status">{t('loading')}</p> : null}
      {snapshot.status === 'error' && view === null ? (
        <div className={css.error} role="alert"><p>{t('loadFailed')}</p><Button size="sm" onClick={() => { void run(load) }}>{t('retry')}</Button></div>
      ) : null}
      {view !== null ? (
        <>
          {!view.supported ? <p className={css.error} role="alert">{t('unsupported')}</p> : null}
          <form className={css.card} onSubmit={(event) => { event.preventDefault(); if (!disabled) void save() }}>
            <div className={css.statusRow}>
              <span className={css.status} data-state={connection} role="status" aria-label={t('status')}>
                <span className={css.dot} aria-hidden="true" />{t(connection)}
              </span>
              <div className={css.fileActions}>
                <Button size="sm" disabled={loading || busy} onClick={() => { void run(load) }}>{t('refresh')}</Button>
                <Button size="sm" variant="outline" disabled={!view.supported || (!active && !snapshot.busy)}
                  onClick={() => { void run(disconnect) }}>{t('disconnect')}</Button>
              </div>
            </div>
            <div className={css.field}>
              <span className={css.label}>{t('profile')}</span>
              <p className={css.hint}>{t('profileHint')}</p>
              <input ref={profileInput} className={css.fileInput} type="file" accept=".ovpn" aria-label={t('profile')}
                disabled={disabled}
                onChange={(event) => { setProfile(event.target.files?.[0] ?? null); setDirty(true); setFailure(null) }} />
              <div className={css.fileActions}>
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => { profileInput.current?.click() }}>
                  {t(view.profileName === null ? 'chooseProfile' : 'replaceProfile')}
                </Button>
                <span className={css.filename}>{profile ? t('selectedFile', { name: profile.name })
                  : view.profileName === null ? t('noProfile') : t('savedProfile', { name: view.profileName })}</span>
              </div>
            </div>
            <div className={css.field}>
              <span className={css.label}>{t('references')}</span>
              <p className={css.hint}>{t('referencesHint')}</p>
              <input ref={filesInput} className={css.fileInput} type="file" multiple aria-label={t('references')}
                disabled={disabled}
                onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); setDirty(true); setFailure(null) }} />
              <div className={css.fileActions}>
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => { filesInput.current?.click() }}>{t('chooseReferences')}</Button>
                {profile !== null || files.length > 0 ? <Button size="sm" disabled={disabled} onClick={clearFiles}>{t('clearSelection')}</Button> : null}
              </div>
              {files.length === 0 ? <p className={css.hint}>{t('noReferences')}</p>
                : <ul className={css.fileList}>{files.map((file, index) => <li key={`${String(index)}:${file.name}`}>{file.name}</li>)}</ul>}
            </div>
            <div className={css.credentials}>
              <label className={css.field}><span className={css.label}>{t('username')}</span>
                <Input value={username} autoComplete="username" disabled={disabled}
                  onChange={(event) => { setUsername(event.target.value); setDirty(true) }} />
              </label>
              <label className={css.field}><span className={css.label}>{t('password')}</span>
                <Input type="password" value={password} autoComplete="new-password" disabled={disabled} aria-label={t('password')}
                  placeholder={t(view.passwordConfigured ? 'passwordKeep' : 'passwordNew')}
                  onChange={(event) => { setPassword(event.target.value); setDirty(true) }} />
                <span className={css.hint}>{t('passwordHint')}</span>
              </label>
            </div>
            <label className={css.toggle}>
              <input type="checkbox" checked={autoConnect} disabled={disabled} aria-label={t('autoConnect')}
                onChange={(event) => { setAutoConnect(event.target.checked); setDirty(true) }} />
              <span className={css.toggleText}><span className={css.label}>{t('autoConnect')}</span><span className={css.hint}>{t('autoConnectHint')}</span></span>
            </label>
            {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
            <p className={css.hint}>{t('connectionHint')}</p>
            <footer className={css.actions}>
              <Button variant="outline" disabled={disabled || dirty || view.profileName === null || !view.passwordConfigured}
                onClick={() => { void run(connect) }}>{t('reconnect')}</Button>
              <Button type="submit" variant="primary" disabled={disabled}>{t(submitting ? 'saving' : 'save')}</Button>
            </footer>
          </form>
        </>
      ) : null}
    </section>
  )
}
