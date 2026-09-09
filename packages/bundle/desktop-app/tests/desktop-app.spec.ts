/** Desktop carrier bundle declaration and native interaction pair. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

describe('dsh-desktop-app bundle', () => {
  it('declares the MessagePort carrier and both native directory-picker faces', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-host-directory-picker-native')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-directory-picker-native')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; name?: string }> }>
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(rows.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'network-openvpn', name: '@deepseek-ai/dsh-network-openvpn' },
      { id: 'vpn-controller', name: '@deepseek-ai/dsh-api-vpn-controller' },
      { id: 'ui-vpn', name: '@deepseek-ai/dsh-client-ui-vpn' },
      { id: 'desktop-transport', name: '@deepseek-ai/dsh-desktop-transport' },
      { id: 'desktop-directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-native' },
      { id: 'desktop-directory-picker-ui', name: '@deepseek-ai/dsh-client-ui-directory-picker-native' },
      { id: 'ui-desktop', name: '@deepseek-ai/dsh-client-ui-desktop' },
    ])
  })
})
