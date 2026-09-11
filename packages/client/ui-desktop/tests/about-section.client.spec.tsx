// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AboutSection,
  type AboutSectionProps,
  type DesktopUpdateState,
} from '../src/client/AboutSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const available: DesktopUpdateState = {
  phase: 'available',
  currentVersion: '0.1.2-alpha.5',
  latestVersion: '0.1.2-alpha.6',
  releaseName: 'DSH Desktop 0.1.2-alpha.6',
  releaseNotes: 'Fixed the fixture feed.',
  progress: null,
  message: null,
}

function props(state: DesktopUpdateState, overrides: Partial<AboutSectionProps> = {}): AboutSectionProps {
  return {
    t,
    useUpdate: (selector: (value: DesktopUpdateState) => unknown) => selector(state),
    checkForUpdate: vi.fn(async () => state),
    downloadUpdate: vi.fn(async () => state),
    installUpdate: vi.fn(async () => state),
    cancelUpdate: vi.fn(async () => state),
    openReleases: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AboutSectionProps
}

function liveProps(
  source: SnapshotStore<DesktopUpdateState>,
  dictionary: typeof en,
  overrides: Partial<AboutSectionProps>,
): AboutSectionProps {
  return props(source.getSnapshot(), {
    t: makeTranslate(dictionary),
    useUpdate: bindSnapshotSelector(source),
    ...overrides,
  })
}

describe.each([{ language: 'en', dictionary: en }, { language: 'zh', dictionary: zh }])(
  'AboutSection $language update commands',
  ({ dictionary }) => {
    it('cancels a pending download and permits another download', async () => {
      const source = createSnapshotStore(available)
      const completion = Promise.withResolvers<DesktopUpdateState>()
      const cancellation = Promise.withResolvers<DesktopUpdateState>()
      const downloaded: DesktopUpdateState = { ...available, phase: 'downloaded' }
      const downloadUpdate = vi.fn()
        .mockImplementationOnce(async () => {
          source.set({ ...available, phase: 'downloading' })
          const result = await completion.promise
          source.set(result)
          return result
        })
        .mockImplementationOnce(async () => {
          source.set(downloaded)
          return downloaded
        })
      const cancelUpdate = vi.fn(() => {
        completion.resolve(available)
        return cancellation.promise
      })
      render(<AboutSection {...liveProps(source, dictionary, { downloadUpdate, cancelUpdate })} />)
      try {
        fireEvent.click(screen.getByRole('button', { name: dictionary['about.download'] }))
        expect(screen.getByRole('status').textContent).toBe(dictionary['about.downloading'])
        const cancel = screen.getByRole('button', { name: dictionary['about.cancelDownload'] })
        expect(cancel.hasAttribute('disabled')).toBe(false)
        fireEvent.click(cancel)
        expect(cancel.hasAttribute('disabled')).toBe(true)
        fireEvent.click(cancel)
        const retryDownload = await screen.findByRole('button', { name: dictionary['about.download'] })
        expect(retryDownload.hasAttribute('disabled')).toBe(true)
        await act(async () => {
          cancellation.resolve(available)
          await cancellation.promise
        })
        await waitFor(() => {
          expect(screen.getByRole('button', { name: dictionary['about.download'] }).hasAttribute('disabled')).toBe(false)
        })
        expect(cancelUpdate).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: dictionary['about.download'] }))
        await waitFor(() => {
          expect(screen.getByRole('button', { name: dictionary['about.install'] }).hasAttribute('disabled')).toBe(false)
        })
        expect(downloadUpdate).toHaveBeenCalledTimes(2)
        expect(screen.getByRole('status').textContent).toBe(dictionary['about.downloaded'])
      } finally {
        await act(async () => {
          completion.resolve(available)
          cancellation.resolve(available)
          await Promise.all([completion.promise, cancellation.promise])
        })
      }
    })

    it.each([
      { command: 'checkForUpdate', button: 'about.check', phase: 'idle', message: 'feed unreachable' },
      { command: 'downloadUpdate', button: 'about.download', phase: 'available', message: 'disk full' },
      { command: 'installUpdate', button: 'about.install', phase: 'downloaded', message: 'installer missing' },
    ] as const)('shows a resolved $command failure and clears it on retry', async ({ command, button, phase, message }) => {
      const source = createSnapshotStore<DesktopUpdateState>({ ...available, phase })
      const failed: DesktopUpdateState = { ...available, phase: 'error', message }
      const fail = vi.fn(async () => {
        source.set(failed)
        return failed
      })
      const retry = vi.fn(async () => {
        source.set({ ...available, phase: 'checking', message: null })
        await Promise.resolve()
        const settled: DesktopUpdateState = { ...available, phase: 'up-to-date' }
        source.set(settled)
        return settled
      })
      const checkForUpdate = command === 'checkForUpdate'
        ? vi.fn().mockImplementationOnce(fail).mockImplementationOnce(retry)
        : retry
      render(<AboutSection {...liveProps(source, dictionary, { [command]: fail, checkForUpdate })} />)
      fireEvent.click(screen.getByRole('button', { name: dictionary[button] }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(`${dictionary['about.error']}: ${message}`)
      expect(fail).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: dictionary['about.check'] }))
      expect(screen.getByRole('status').textContent).toBe(dictionary['about.checking'])
      await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(dictionary['about.upToDate']) })
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('shows installation status and opens the releases page', async () => {
      const source = createSnapshotStore<DesktopUpdateState>({ ...available, phase: 'downloaded' })
      const installUpdate = vi.fn(async () => {
        const installing: DesktopUpdateState = { ...available, phase: 'installing' }
        source.set(installing)
        return installing
      })
      const openReleases = vi.fn(async () => {})
      render(<AboutSection {...liveProps(source, dictionary, { installUpdate, openReleases })} />)
      fireEvent.click(screen.getByRole('button', { name: dictionary['about.install'] }))
      expect(screen.getByRole('status').textContent).toBe(dictionary['about.installing'])
      await waitFor(() => {
        expect(screen.getByRole('button', { name: dictionary['about.releases'] }).hasAttribute('disabled')).toBe(false)
      })
      fireEvent.click(screen.getByRole('button', { name: dictionary['about.releases'] }))
      expect(openReleases).toHaveBeenCalledTimes(1)
    })
  },
)

describe('AboutSection', () => {
  it('shows the installed version in the idle state', () => {
    render(<AboutSection {...props({ ...available, phase: 'idle', latestVersion: null })} />)
    expect(screen.getByText('0.1.2-alpha.5')).toBeTruthy()
    expect(screen.getByRole('button', { name: en['about.check'] })).toBeTruthy()
  })

  it('offers download when an update is available and shows its notes', () => {
    render(<AboutSection {...props(available)} />)
    expect(screen.getByText(`${en['about.available']} 0.1.2-alpha.6`)).toBeTruthy()
    expect(screen.getByText(en['about.releaseNotes'])).toBeTruthy()
    expect(screen.getByText('Fixed the fixture feed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: en['about.download'] })).toBeTruthy()
  })

  it('reports up to date with the feed version', () => {
    render(<AboutSection {...props({ ...available, phase: 'up-to-date' })} />)
    expect(screen.getByText(en['about.upToDate'])).toBeTruthy()
    expect(screen.getByText(en['about.current'])).toBeTruthy()
  })

  it('renders download progress with byte totals', () => {
    const state: DesktopUpdateState = {
      ...available,
      phase: 'downloading',
      progress: { percent: 42, transferred: 42_000, total: 100_000 },
    }
    render(<AboutSection {...props(state)} />)
    expect(screen.getByLabelText(en['about.progress'])).toBeTruthy()
    expect(screen.getByText('42% · 0.0 MB / 0.1 MB')).toBeTruthy()
  })

  it('shows the unsupported hint and keeps the check action', () => {
    render(<AboutSection {...props({ ...available, phase: 'unsupported', latestVersion: null })} />)
    expect(screen.getByText(en['about.unsupported'])).toBeTruthy()
    expect(screen.getByText(en['about.unsupportedHint'])).toBeTruthy()
  })

  it.each([new Error('feed unreachable'), 'feed unreachable'])('surfaces rejected command failures as an alert: %s', async (reason) => {
    const checkForUpdate = vi.fn().mockRejectedValue(reason)
    render(<AboutSection {...props({ ...available, phase: 'idle', latestVersion: null }, { checkForUpdate })} />)
    fireEvent.click(screen.getByRole('button', { name: en['about.check'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('feed unreachable')
  })
})
