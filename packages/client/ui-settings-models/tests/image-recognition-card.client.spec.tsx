// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImageRecognitionCard } from '../src/client/ImageRecognitionCard.tsx'
import {
  ImageRecognitionCardController,
  imageRecognitionCandidates,
  type ImageRecognitionSettings,
} from '../src/client/image-recognition-controller.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]

afterEach(cleanup)

function scope(initial: ImageRecognitionSettings): {
  value: SettingsScope<ImageRecognitionSettings>
  mutate: ReturnType<typeof vi.fn>
} {
  let snapshot: SettingsScopeSnapshot<ImageRecognitionSettings> = {
    status: 'ready',
    value: initial,
    base: undefined,
    user: initial,
    revision: 0,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn(async (ops: readonly SettingsPathOpView[]) => {
    const op = ops[0]
    const model = op !== undefined && op.op === 'set'
      ? op.value as ImageRecognitionSettings['model']
      : null
    snapshot = { ...snapshot, value: { model }, user: { model }, revision: (snapshot.revision ?? 0) + 1 }
    for (const listener of listeners) listener()
  })
  return {
    mutate,
    value: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      mutate,
      set: vi.fn(),
      unset: vi.fn(),
    },
  }
}

function catalog() {
  return [{
    id: 'provider',
    name: 'Provider',
    models: [
      { id: 'text', name: 'Text', inputModalities: ['text'] as const },
      { id: 'vision', name: 'Vision Model', inputModalities: ['text', 'image'] as const },
    ],
  }]
}

function clientContext() {
  return {
    remote: {
      session: {
        modelCatalog: vi.fn(() => Promise.resolve({
          ok: true,
          value: { default: { provider: 'provider', model: 'text' }, groups: catalog(), failures: [] },
        })),
      },
    },
  } as never
}

describe('image recognition model card', () => {
  it('offers only explicit visual models and saves one exact route', async () => {
    const settings = scope({ model: null })
    const controller = new ImageRecognitionCardController(settings.value, clientContext())
    render(<ImageRecognitionCard controller={controller} t={t} />)

    await screen.findByRole('option', { name: 'Provider · Vision Model' })
    expect(screen.queryByRole('option', { name: 'Provider · Text' })).toBeNull()
    fireEvent.change(screen.getByLabelText(en.recognitionModel), {
      target: { value: JSON.stringify(['provider', 'vision']) },
    })
    fireEvent.click(screen.getByText(en.recognitionSave))

    await waitFor(() => { expect(settings.mutate).toHaveBeenCalledOnce() })
    expect(settings.mutate.mock.calls[0]?.[0]).toEqual([{
      op: 'set', path: ['model'], value: { provider: 'provider', model: 'vision' },
    }])
    expect(controller.currentTarget()).toEqual({ provider: 'provider', model: 'vision' })
    controller.dispose()
  })

  it('retains a stale saved route so the user can clear it', async () => {
    const settings = scope({ model: { provider: 'gone', model: 'old-vision' } })
    const controller = new ImageRecognitionCardController(settings.value, clientContext())
    render(<ImageRecognitionCard controller={controller} t={t} />)

    await screen.findByRole('option', { name: `gone/old-vision · ${en.recognitionUnavailable}` })
    fireEvent.change(screen.getByLabelText(en.recognitionModel), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.recognitionSave))
    await waitFor(() => { expect(settings.mutate).toHaveBeenCalledOnce() })
    expect(settings.mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['model'], value: null }])
    controller.dispose()
  })

  it('joins capability metadata without guessing unknown models', () => {
    expect(imageRecognitionCandidates(catalog(), null).map(candidate => candidate.model)).toEqual(['vision'])
  })

  it('keeps catalog invalidations lazy until the card first requests models', async () => {
    const settings = scope({ model: null })
    const ctx = clientContext() as {
      remote: { session: { modelCatalog: ReturnType<typeof vi.fn> } }
    }
    const controller = new ImageRecognitionCardController(settings.value, ctx as never)

    controller.refreshCatalog()
    expect(ctx.remote.session.modelCatalog).not.toHaveBeenCalled()

    controller.ensureCatalog()
    await waitFor(() => { expect(ctx.remote.session.modelCatalog).toHaveBeenCalledOnce() })
    controller.refreshCatalog()
    await waitFor(() => { expect(ctx.remote.session.modelCatalog).toHaveBeenCalledTimes(2) })
    controller.dispose()
  })
})
