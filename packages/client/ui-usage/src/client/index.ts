/** Register the usage page against the Client controller's observable snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-usage-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UsageSection } from './UsageSection.tsx'
import { en, zh } from './locales.ts'

export type { UsageSectionInjected, UsageSectionProps } from './UsageSection.tsx'
export type { UsageLocaleKey } from './locales.ts'

/** Services required by this browser contribution. */
export const inject = ['slots', 'locale', 'usage']

/**
 * Contribute a localized settings page for recorded usage.
 * @param ctx - Browser plugin context with the usage Client model.
 */
export function apply(ctx: Context): void {
  const namespace = 'settings.usage'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-usage: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 40,
    label: () => t('title'),
    locale: namespace,
    inject: () => ({
      hooks: { usage: ctx.usage.snapshot },
      load: (days: 7 | 30) => ctx.usage.load({
        days, timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      refresh: () => ctx.usage.refresh(),
    }),
  }, UsageSection))
}
