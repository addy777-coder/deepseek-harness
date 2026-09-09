/** Per-provider network selection for model requests. */

import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Render the provider's network selection and VPN availability guidance.
 * @param props - current selection, edit callback, disabled state, and localized copy.
 * @returns the network field.
 */
export function NetworkField(props: {
  value: 'direct' | 'vpn'
  onChange: (value: 'direct' | 'vpn') => void
  disabled: boolean
  t: (key: keyof typeof en) => string
}): ReactNode {
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{props.t('network')}</span>
      <select
        className={`${styles['input']} ${styles['selectInput']}`}
        aria-label={props.t('network')}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(event.target.value === 'vpn' ? 'vpn' : 'direct') }}
      >
        <option value="direct">{props.t('networkDirect')}</option>
        <option value="vpn">{props.t('networkVpn')}</option>
      </select>
      {props.value === 'vpn' ? <p className={styles['advancedHint']}>{props.t('networkVpnHint')}</p> : null}
    </div>
  )
}
