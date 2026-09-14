// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SectionModal, SidebarSectionHeader } from '../src/client/rows/Sections.tsx'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import type { RowDragProps } from '../src/client/rows/Rows.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

it('closes a section menu on Escape and reports a non-Error save rejection', async () => {
  const drag: RowDragProps = { start: vi.fn(), end: vi.fn(), active: false, marker: null, hover: vi.fn(), drop: vi.fn() }
  const view = render(<SidebarSectionHeader title="Menu" expanded onToggle={vi.fn()} onRename={vi.fn()}
    onDelete={vi.fn()} onUp={vi.fn()} onDown={vi.fn()} draggable inside={false} drag={drag} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: '分区“Menu”的操作' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  view.unmount()
  render(<SectionModal dialog={{ type: 'create' }} sections={[]} onClose={vi.fn()} t={t}
    onCommit={async () => { throw 'offline' }} />)
  fireEvent.change(screen.getByLabelText('分区名称'), { target: { value: 'Retry' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新建分区' })) })
  expect(screen.getByRole('alert').textContent).toBe('offline')
})

it('distinguishes both heading halves and rejects drops without an active sidebar drag', () => {
  const drag: RowDragProps = { start: vi.fn(), end: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn() }
  const props = { title: 'Heading', expanded: true, onToggle: vi.fn(), draggable: true, inside: false, t, drag }
  const view = render(<SidebarSectionHeader {...props} />)
  const heading = screen.getByRole('button', { name: 'Heading' }).parentElement as HTMLElement
  const fire = (kind: 'dragOver' | 'drop', y: number): void => {
    const event = kind === 'dragOver' ? createEvent.dragOver(heading) : createEvent.drop(heading)
    Object.defineProperty(event, 'clientY', { value: y })
    Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } })
    fireEvent(heading, event)
  }
  fire('dragOver', -1)
  fire('drop', -1)
  expect(drag.drop).not.toHaveBeenCalled()
  view.rerender(<SidebarSectionHeader {...props} drag={{ ...drag, active: true }} />)
  fire('dragOver', -1)
  fire('dragOver', 1)
  fire('drop', -1)
  fire('drop', 1)
  expect(drag.hover).toHaveBeenCalledWith('before')
  expect(drag.hover).toHaveBeenCalledWith('after')
  expect(drag.drop).toHaveBeenCalledWith('before')
  expect(drag.drop).toHaveBeenCalledWith('after')
})

it('ignores an empty name, closes an idle dialog, and retains a pending commit through Escape', async () => {
  const close = vi.fn()
  let finish!: () => void
  const commit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const props = { dialog: { type: 'create' as const }, sections: [], onCommit: commit, onClose: close, t }
  const view = render(<SectionModal {...props} />)
  fireEvent.keyDown(screen.getByLabelText('分区名称'), { key: 'Enter' })
  expect(commit).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  close.mockClear()
  view.rerender(<SectionModal {...props} />)
  fireEvent.change(screen.getByLabelText('分区名称'), { target: { value: 'New' } })
  fireEvent.keyDown(screen.getByLabelText('分区名称'), { key: 'ArrowDown' })
  expect(commit).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByLabelText('分区名称'), { key: 'Enter' })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  await act(async () => { finish() })
  expect(close).toHaveBeenCalledOnce()
})
