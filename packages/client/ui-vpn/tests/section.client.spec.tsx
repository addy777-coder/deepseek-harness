// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SaveVpnRequest, VpnClientSnapshot, VpnSettingsView } from '@deepseek-ai/dsh-api-vpn-controller/client'
import { VpnSection, type VpnSectionProps } from '../src/client/VpnSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import { vpnFailureText } from '../src/client/failure.ts'

afterEach(cleanup)

function settings(overrides: Partial<VpnSettingsView> = {}): VpnSettingsView {
  return { profileName: 'company.ovpn', username: 'employee', passwordConfigured: true,
    autoConnect: true, connection: 'disconnected', failure: null, supported: true, ...overrides }
}

function translator(dictionary = en) {
  return (key: keyof typeof en, params: Readonly<Record<string, unknown>> = {}) => dictionary[key]
    .replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = params[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : name
    })
}

function setup(state: Partial<VpnClientSnapshot> = {}, dictionary = en) {
  const source = createSnapshotStore<VpnClientSnapshot>({ status: 'ready', data: settings(), busy: false, error: null, ...state })
  const load = vi.fn<() => Promise<void>>().mockResolvedValue()
  const saveAndConnect = vi.fn<(request: SaveVpnRequest) => Promise<boolean>>().mockResolvedValue(true)
  const connect = vi.fn<() => Promise<void>>().mockResolvedValue()
  const disconnect = vi.fn<() => Promise<void>>().mockResolvedValue()
  const props = { t: translator(dictionary), useVpn: bindSnapshotSelector(source), load,
    saveAndConnect, connect, disconnect } as unknown as VpnSectionProps
  const rendered = render(<VpnSection {...props} />)
  return { source, props, rendered, load, saveAndConnect, connect, disconnect }
}

function file(name: string, content: string, read: () => Promise<string> = async () => content): File {
  const selected = new File([content], name)
  // jsdom's File does not implement Blob.text(); this instance-local reader
  // represents the browser operation without replacing process-global APIs.
  Object.defineProperty(selected, 'text', { value: read })
  return selected
}

function selectProfile(selected: File) {
  fireEvent.change(screen.getByLabelText(en.profile), { target: { files: [selected] } })
}

describe('VPN settings section', () => {
  it('shows pending settings and opens the native file selectors', () => {
    const b = setup({ status: 'loading', data: null })
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    act(() => { b.source.set({ status: 'ready', data: settings(), busy: false, error: null }) })
    const profile = screen.getByLabelText<HTMLInputElement>(en.profile)
    const references = screen.getByLabelText<HTMLInputElement>(en.references)
    const openProfile = vi.spyOn(profile, 'click').mockImplementation(() => {})
    const openReferences = vi.spyOn(references, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: en.replaceProfile }))
    fireEvent.click(screen.getByRole('button', { name: en.chooseReferences }))
    expect(openProfile).toHaveBeenCalledOnce()
    expect(openReferences).toHaveBeenCalledOnce()
    selectProfile(file('replacement.ovpn', 'client'))
    fireEvent.change(references, { target: { files: [file('ca.crt', 'certificate')] } })
    fireEvent.click(screen.getByRole('button', { name: en.clearSelection }))
    expect(screen.queryByText('ca.crt')).toBeNull()
    fireEvent.change(profile, { target: { files: null } })
    fireEvent.change(references, { target: { files: null } })
    expect(screen.queryByRole('button', { name: en.clearSelection })).toBeNull()
  })

  it('loads on opening, renders status, and leaves saved passwords blank', async () => {
    const b = setup()
    expect(b.load).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLInputElement>(en.username).value).toBe('employee')
    const password = screen.getByLabelText(en.password) as HTMLInputElement
    expect(password.type).toBe('password')
    expect(password.value).toBe('')
    expect(password.placeholder).toBe(en.passwordKeep)
    expect(screen.getByRole('status', { name: en.status }).textContent).toBe(en.disconnected)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(b.saveAndConnect).toHaveBeenCalledExactlyOnceWith({ username: 'employee', autoConnect: true }) })
  })

  it('uploads selected file names and contents, saves credentials, and clears sensitive drafts', async () => {
    const b = setup({ data: settings({ profileName: null, username: '', passwordConfigured: false, connection: 'unconfigured' }) })
    const profile = file('company.ovpn', 'client\nca company-ca.crt\n')
    Object.defineProperty(profile, 'webkitRelativePath', { value: 'private/path/company.ovpn' })
    selectProfile(profile)
    fireEvent.change(screen.getByLabelText(en.references), { target: { files: [file('company-ca.crt', 'certificate')] } })
    fireEvent.change(screen.getByLabelText(en.username), { target: { value: ' employee ' } })
    fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'local-only-secret' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.autoConnect }))
    b.saveAndConnect.mockImplementation(async () => {
      b.source.set({ ...b.source.getSnapshot(), data: settings({ autoConnect: false }) })
      return true
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await vi.waitFor(() => {
      expect(b.saveAndConnect).toHaveBeenCalledExactlyOnceWith({
        profile: { name: 'company.ovpn', content: 'client\nca company-ca.crt\n' },
        files: [{ name: 'company-ca.crt', content: 'certificate' }],
        username: 'employee', password: 'local-only-secret', autoConnect: false,
      })
      expect(screen.getByLabelText<HTMLInputElement>(en.password).value).toBe('')
    })
    expect(screen.queryByText('company-ca.crt')).toBeNull()
    expect(b.rendered.container.textContent).not.toContain('local-only-secret')
    expect(b.rendered.container.textContent).not.toContain('private/path')
  })

  it('keeps form drafts when a connection status update arrives', () => {
    const b = setup()
    fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'draft-user' } })
    act(() => { b.source.set({ ...b.source.getSnapshot(), data: settings({ connection: 'connected' }) }) })
    expect(screen.getByLabelText<HTMLInputElement>(en.username).value).toBe('draft-user')
    expect(screen.getByRole('status', { name: en.status }).textContent).toBe(en.connected)
    expect(screen.getByRole('button', { name: en.reconnect }).hasAttribute('disabled')).toBe(true)
  })

  it('allows cancellation of an active connection attempt and forwards reconnect and refresh', () => {
    const b = setup()
    fireEvent.click(screen.getByRole('button', { name: en.reconnect }))
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(b.connect).toHaveBeenCalledOnce()
    expect(b.load).toHaveBeenCalledTimes(2)
    act(() => { b.source.set({ ...b.source.getSnapshot(), busy: true, data: settings({ connection: 'connecting' }) }) })
    fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
    expect(b.disconnect).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
  })

  it('allows disconnect while save-and-connect is awaiting the Host', async () => {
    const b = setup()
    const finish = Promise.withResolvers<boolean>()
    b.saveAndConnect.mockImplementation(async () => {
      b.source.set({ ...b.source.getSnapshot(), busy: true })
      return finish.promise
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.submit(b.rendered.container.querySelector('form')!)
    expect(b.saveAndConnect).toHaveBeenCalledOnce()
    const disconnect = screen.getByRole('button', { name: en.disconnect })
    expect(disconnect.hasAttribute('disabled')).toBe(false)
    fireEvent.click(disconnect)
    expect(b.disconnect).toHaveBeenCalledOnce()
    await act(async () => { finish.resolve(true); await finish.promise })
  })

  it('finishes a saved draft when the settings form is withdrawn during the call', async () => {
    const b = setup()
    const saved = Promise.withResolvers<boolean>()
    b.saveAndConnect.mockReturnValueOnce(saved.promise)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    act(() => { b.source.set({ status: 'loading', data: null, error: null, busy: true }) })
    await act(async () => { saved.resolve(true); await saved.promise })
    expect(screen.getByRole('status').textContent).toBe(en.loading)
  })

  it('reports command failures without exposing native exceptions', async () => {
    const b = setup({ data: settings({ connection: 'connected' }) })
    b.disconnect.mockRejectedValueOnce(new Error('private native detail'))
    fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
    await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.operationFailed) })
    expect(b.rendered.container.textContent).not.toContain('private native detail')
    const stopped = Promise.withResolvers<undefined>()
    b.disconnect.mockReturnValueOnce(stopped.promise)
    fireEvent.click(screen.getByRole('button', { name: en.disconnect }))
    b.rendered.unmount()
    await act(async () => { stopped.reject(new Error('closed page')); await Promise.allSettled([stopped.promise]) })
  })

  it.each([
    ['profileRequired', null, [], 'employee', 'secret', null],
    ['profileExtension', file('wrong.txt', 'client'), [], 'employee', 'secret', null],
    ['referencesNeedProfile', null, [file('ca.crt', 'certificate')], 'employee', 'secret', 'saved.ovpn'],
    ['credentialsRequired', file('company.ovpn', 'client'), [], '', '', null],
  ] as const)('blocks invalid drafts: %s', async (reason, profile, references, username, password, saved) => {
    const b = setup({ data: settings({ profileName: saved, username, passwordConfigured: false }) })
    if (profile) selectProfile(profile)
    if (references.length) fireEvent.change(screen.getByLabelText(en.references), { target: { files: references } })
    if (password) fireEvent.change(screen.getByLabelText(en.password), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getByRole('alert').textContent).toBe(en[reason])
    expect(b.saveAndConnect).not.toHaveBeenCalled()
  })

  it('reports file read failures without rendering the reader exception', async () => {
    const b = setup()
    selectProfile(file('company.ovpn', '', async () => { throw new Error('private reader detail') }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.fileReadFailed) })
    expect(b.saveAndConnect).not.toHaveBeenCalled()
    expect(b.rendered.container.textContent).not.toContain('private reader detail')
  })

  it('does not submit an import when the settings page closes during file reading', async () => {
    const b = setup()
    let finishRead!: (content: string) => void
    const reading = new Promise<string>((resolve) => { finishRead = resolve })
    selectProfile(file('company.ovpn', '', () => reading))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    b.rendered.unmount()
    await act(async () => { finishRead('client'); await reading })
    expect(b.saveAndConnect).not.toHaveBeenCalled()
  })

  it('ignores a file-read failure after the settings page closes', async () => {
    const b = setup()
    const reading = Promise.withResolvers<string>()
    selectProfile(file('company.ovpn', '', () => reading.promise))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    b.rendered.unmount()
    await act(async () => { reading.reject(new Error('closed reader')); await Promise.allSettled([reading.promise]) })
    expect(b.saveAndConnect).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('ignores save %s after the settings page closes', async (outcome) => {
    const b = setup()
    const saved = Promise.withResolvers<boolean>()
    b.saveAndConnect.mockReturnValueOnce(saved.promise)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    b.rendered.unmount()
    await act(async () => {
      if (outcome === 'success') saved.resolve(true)
      else saved.reject(new Error('closed page'))
      await Promise.allSettled([saved.promise])
    })
    expect(b.saveAndConnect).toHaveBeenCalledOnce()
  })

  it('keeps an unsuccessful save available for retry and hides unexpected exceptions', async () => {
    const b = setup()
    fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'new-secret' } })
    b.saveAndConnect.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(false) })
    expect(screen.getByLabelText<HTMLInputElement>(en.password).value).toBe('new-secret')
    b.saveAndConnect.mockRejectedValueOnce(new Error('private native output'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.operationFailed) })
    expect(b.rendered.container.textContent).not.toContain('private native output')
  })

  it('renders localized known failures and ignores native error messages', () => {
    const b = setup({ data: settings({ connection: 'error', failure: { code: 'AUTH_FAILED', message: 'private native output' } }) }, zh)
    expect(screen.getByRole('alert').textContent).toBe(zh.authenticationFailed)
    expect(b.rendered.container.textContent).not.toContain('private native output')
    expect(vpnFailureText('UNKNOWN_STATUS', translator())).toBe('The VPN operation failed (UNKNOWN_STATUS).')
    expect(vpnFailureText('VPN_PROFILE_REFERENCE_MISSING', translator(zh))).toBe(zh.referenceMissing)
    expect(vpnFailureText('VPN_RUNTIME_INTEGRITY_FAILED', translator())).toBe(en.runtimeInvalid)
    expect(vpnFailureText('CERT_VERIFY_FAIL', translator())).toBe(en.certificateFailed)
    expect(vpnFailureText('VPN_PLATFORM_UNSUPPORTED', translator())).toBe(en.unsupported)
  })

  it('shows a committed-save follow-up failure ahead of an older connection error', () => {
    setup({ error: 'VPN_PROVIDER_CONFIGURATION_FAILED', data: settings({ connection: 'error', failure: { code: 'AUTH_FAILED' } }) })
    expect(screen.getByRole('alert').textContent).toBe(en.savedProviderFailed)
  })

  it('disables unsupported hosts and provides a retry when settings fail to load', () => {
    const b = setup({ status: 'error', data: null, error: 'RPC_UNAVAILABLE' })
    expect(screen.getByRole('alert').textContent).toContain(en.loadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(b.load).toHaveBeenCalledTimes(2)
    act(() => { b.source.set({ status: 'ready', data: settings({ supported: false }), error: null, busy: false }) })
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
  })

  it.each(['unconfigured', 'connected', 'error'] as const)('records the owner-local %s settings presentation', async (connection) => {
    const data = settings({ connection, ...(connection === 'unconfigured'
      ? { profileName: null, username: '', passwordConfigured: false }
      : connection === 'error' ? { failure: { code: 'AUTH_FAILED' } } : {}) })
    const snapshot: VpnClientSnapshot = { status: 'ready', data, busy: false, error: null }
    const props = {
      t: translator(), useVpn: (select: (value: VpnClientSnapshot) => unknown) => select(snapshot),
      load: async () => {}, saveAndConnect: async () => true, connect: async () => {}, disconnect: async () => {},
    } as unknown as VpnSectionProps
    const html = renderToStaticMarkup(<VpnSection {...props} />)
    await expect(html + '\n').toMatchFileSnapshot(`./expected/${connection}.expected.html`)
  })
})
