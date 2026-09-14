/** Custom section controls and the shared section name/delete dialog. */
import { useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconEllipsisOutline16, IconTriangleRightFill14, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSection } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { RowDragProps } from './Rows.tsx'
import css from './Sections.module.css'

/** The browser owns the selected section; dialog fields live only while the dialog is mounted. */
export type SectionDialog = { type: 'create' } | { type: 'rename' | 'delete'; section: SidebarSection }

/**
 * Render a section heading with an independently focusable fold button and actions menu.
 * @param props - localized title, section actions, and drag/drop callbacks.
 * @returns the section heading.
 */
export function SidebarSectionHeader({ title, expanded, onToggle, onRename, onDelete, onUp, onDown, drag,
  draggable, inside, t }: {
  title: string
  expanded: boolean
  onToggle: () => void
  onRename?: (() => void) | undefined
  onDelete?: (() => void) | undefined
  onUp?: (() => void) | undefined
  onDown?: (() => void) | undefined
  drag: RowDragProps
  draggable: boolean
  inside: boolean
  t: WorkspaceBrowserProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuActions = {
    rename: { label: t('section.rename'), run: onRename },
    up: { label: t('section.moveUp'), run: onUp },
    down: { label: t('section.moveDown'), run: onDown },
    delete: { label: t('section.delete'), run: onDelete },
  }
  return (
    <div
      className={clsx(css.heading, inside && css.inside,
        drag.marker === 'before' && css.before, drag.marker === 'after' && css.after)}
      draggable={draggable}
      onDragStart={draggable ? (event) => {
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', title)
        drag.start()
      } : undefined}
      onDragEnd={drag.end}
      onDragOver={(event) => {
        if (!drag.active) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        drag.hover(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
      onDrop={(event) => {
        if (!drag.active) return
        event.preventDefault()
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        drag.drop(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
      }}
    >
      <button type="button" className={css.toggle} aria-expanded={expanded} onClick={onToggle}>
        <IconTriangleRightFill14 className={clsx(css.arrow, expanded && css.expanded)} />
        <span className={css.title}>{title}</span>
      </button>
      {onRename !== undefined && (
        <Menu
          open={menuOpen} onClose={() => { setMenuOpen(false) }} portal
          items={Object.entries(menuActions).map(([id, action]) => ({
            id, label: action.label, disabled: action.run === undefined, danger: id === 'delete',
          }))}
          onSelect={(id) => {
            setMenuOpen(false)
            // Menu emits only an enabled key from this same action map.
            const action = menuActions[id as keyof typeof menuActions].run as () => void
            action()
          }}
          anchor={(
            <button type="button" className={css.actions} aria-label={t('section.actions', { name: title })}
              onClick={() => { setMenuOpen(value => !value) }}>
              <IconEllipsisOutline16 />
            </button>
          )}
        />
      )}
    </div>
  )
}

/**
 * Edit a unique section name or confirm restoring all entries after deletion.
 * @param props - dialog target, current section names, and commit/cancel actions.
 * @returns the modal, including retryable operation failures.
 */
export function SectionModal({ dialog, sections, onCommit, onClose, t }: {
  dialog: SectionDialog
  sections: readonly SidebarSection[]
  onCommit: (title: string) => Promise<void>
  onClose: () => void
  t: WorkspaceBrowserProps['t']
}) {
  const [title, setTitle] = useState(dialog.type === 'create' ? '' : dialog.section.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = title.trim()
  const duplicate = sections.some(section => section.title === trimmed
    && (dialog.type === 'create' || section.id !== dialog.section.id))
  const invalid = dialog.type !== 'delete' && (trimmed === '' || duplicate)
  const commit = (): void => {
    /* v8 ignore next -- both submit controls are disabled while a commit is pending. */
    if (busy) return
    if (invalid) return
    setBusy(true)
    setError(null)
    onCommit(trimmed).then(onClose).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} closeLabel={t('close')}
      title={t(dialog.type === 'create' ? 'section.create' : dialog.type === 'rename' ? 'section.rename' : 'section.delete')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || invalid} onClick={commit}>
            {t(dialog.type === 'delete' ? 'section.delete' : dialog.type === 'create' ? 'section.create' : 'section.save')}
          </Button>
        </>
      )}>
      {dialog.type === 'delete'
        ? <p>{t('section.deleteDescription', { name: dialog.section.title })}</p>
        : <input className={css.input} aria-label={t('section.name')} autoFocus value={title} disabled={busy}
          onChange={(event) => { setTitle(event.target.value); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />}
      {duplicate && dialog.type !== 'delete' && <p role="alert">{t('section.duplicate', { name: trimmed })}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </Modal>
  )
}
