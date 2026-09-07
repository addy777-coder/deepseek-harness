// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginManager,
  type DesktopPluginInfo,
  type PluginManagerProps,
} from '../src/client/PluginManager.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]
const plugin: DesktopPluginInfo = {
  name: '@fixture/desktop-plugin',
  version: '1.2.3',
  spec: '^1.2.0',
  resolution: 'integrity:sha512-fixture',
  bundlePatch: './cordis.patch.yml',
  clientBundle: 'verified',
}

function props(overrides: Partial<PluginManagerProps> = {}): PluginManagerProps {
  return {
    t,
    list: vi.fn(async () => [plugin]),
    stage: vi.fn(async () => ({ token: 'stage-1', action: 'install', packages: [plugin] })),
    apply: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...overrides,
  } as unknown as PluginManagerProps
}

describe('PluginManager', () => {
  it('shows resolved package, integrity, bundle, and Client validation metadata', async () => {
    render(<PluginManager {...props()} />)

    await screen.findByText(plugin.name)
    expect(screen.getByText(plugin.resolution)).toBeTruthy()
    expect(screen.getByText(plugin.bundlePatch!)).toBeTruthy()
    expect(screen.getByText(en['plugins.client.verified'])).toBeTruthy()
  })

  it('stages exactly one package spec and recovers when native confirmation cancels', async () => {
    const stage = vi.fn(async () => ({ token: 'stage-1', action: 'install' as const, packages: [plugin] }))
    const apply = vi.fn(async () => {})
    render(<PluginManager {...props({ stage, apply })} />)
    await screen.findByText(plugin.name)

    fireEvent.change(screen.getByLabelText(en['plugins.placeholder']), {
      target: { value: '@fixture/desktop-plugin@1.2.3' },
    })
    fireEvent.click(screen.getByRole('button', { name: en['plugins.install'] }))
    await screen.findByText(en['plugins.resolved'])
    expect(stage).toHaveBeenCalledWith({ action: 'install', spec: '@fixture/desktop-plugin@1.2.3' })

    const applyButton = screen.getByRole('button', { name: en['plugins.apply'] })
    fireEvent.click(applyButton)
    await waitFor(() => { expect(apply).toHaveBeenCalledWith('stage-1') })
    await waitFor(() => { expect(applyButton).toHaveProperty('disabled', false) })
  })
})
