/** Register localized VPN settings against the Client controller's public snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import type { SaveVpnRequest } from '@deepseek-ai/dsh-api-vpn-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VpnSection } from './VpnSection.tsx'
import { en, zh } from './locales.ts'

export type { VpnSectionInjected, VpnSectionProps } from './VpnSection.tsx'
export type { VpnLocaleKey } from './locales.ts'

/** Services required by the VPN settings contribution. */
export const inject = ['slots', 'locale', 'vpn']

/**
 * Contribute file import and connection controls with effect-owned registrations.
 * @param ctx - Client context exposing the VPN controller and settings slots.
 */
export function apply(ctx: Context): void {
  const namespace = 'settings.vpn'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'ui-vpn: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'vpn', order: 35, label: () => t('title'), locale: namespace,
    inject: () => ({
      hooks: { vpn: ctx.vpn.snapshot },
      load: () => ctx.vpn.load(),
      saveAndConnect: (request: SaveVpnRequest) => ctx.vpn.saveAndConnect(request),
      connect: () => ctx.vpn.connect(),
      disconnect: () => ctx.vpn.disconnect(),
    }),
  }, VpnSection))
}
