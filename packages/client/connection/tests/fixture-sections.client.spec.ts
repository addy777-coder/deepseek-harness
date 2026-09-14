import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionRpcResult } from '../src/rpc.ts'
import { createFixtureSections } from '../src/client/fixture-sections.ts'
import type { FixtureSectionId, FixtureWorkspaceId } from '../src/client/fixture-sections.ts'

const wid = (id: string) => id as FixtureWorkspaceId
const sid = (id: string) => id as SessionId
function value<T>(result: ConnectionRpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function fixture() {
  const workspaces = [{ workspaceId: wid('a') }, { workspaceId: wid('b') }, { workspaceId: wid('c') }]
  const changed = vi.fn()
  const model = createFixtureSections(workspaces, id => id === 'child' ? 'subagent' : id === 'missing' ? undefined : 'ordinary', changed)
  return { workspaces, changed, model }
}
describe('fixture sidebar protocol', () => {
  it('keeps one placement, orders projects and sessions, and restores defaults', () => {
    const { workspaces, changed, model } = fixture()
    const first = value(model.createSection({ title: ' First ' })).sectionId
    const second = value(model.createSection({ title: 'Second' })).sectionId
    expect(model.snapshot().sections[0]?.title).toBe('First')
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: first }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('b'), sectionId: first, beforeWorkspaceId: wid('a') }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: second }))
    value(model.insertSectionBefore({ sectionId: second, beforeSectionId: first }))
    value(model.insertSectionBefore({ sectionId: first }))
    value(model.renameSection({ sectionId: second, title: 'Renamed' }))
    value(model.moveSessionToSection({ sessionId: sid('one'), sectionId: first }))
    value(model.moveSessionToSection({ sessionId: sid('two'), sectionId: first, beforeSessionId: sid('one') }))
    value(model.moveSessionToSection({ sessionId: sid('one'), sectionId: second }))
    value(model.moveSessionToSection({ sessionId: sid('two'), sectionId: null }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: null, beforeWorkspaceId: wid('c') }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: second }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: null }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: first, beforeWorkspaceId: wid('b') }))
    value(model.deleteSection({ sectionId: first }))
    expect(workspaces.map(workspace => workspace.workspaceId)).toEqual(['c', 'a', 'b'])
    expect(model.snapshot().sections[0]?.sessionIds).toEqual(['one'])
    expect(changed).toHaveBeenLastCalledWith(model.snapshot())
    const detached = model.snapshot()
    detached.sections[0]?.sessionIds.push(sid('outside'))
    expect(model.snapshot().sections[0]?.sessionIds).toEqual(['one'])
  })

  it('preserves the revision for self moves and rejected operations', () => {
    const { model } = fixture()
    const sectionId = value(model.createSection({ title: 'First' })).sectionId
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId }))
    value(model.moveSessionToSection({ sessionId: sid('one'), sectionId }))
    const prior = model.snapshot()
    value(model.renameSection({ sectionId, title: ' First ' }))
    value(model.insertSectionBefore({ sectionId, beforeSectionId: sectionId }))
    value(model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId, beforeWorkspaceId: wid('a') }))
    value(model.moveSessionToSection({ sessionId: sid('one'), sectionId, beforeSessionId: sid('one') }))
    expect(model.snapshot()).toEqual(prior)
    const rejected = [
      () => model.createSection({ title: '' }),
      () => model.createSection({ title: 'First' }),
      () => model.deleteSection({ sectionId: 'missing' as FixtureSectionId }),
      () => model.insertSectionBefore({ sectionId, beforeSectionId: 'missing' as FixtureSectionId }),
      () => model.moveWorkspaceToSection({ workspaceId: wid('missing'), sectionId }),
      () => model.moveWorkspaceToSection({ workspaceId: wid('a'), sectionId: null, beforeWorkspaceId: wid('a') }),
      () => model.moveSessionToSection({ sessionId: sid('missing'), sectionId }),
      () => model.moveSessionToSection({ sessionId: sid('child'), sectionId }),
      () => model.moveSessionToSection({ sessionId: sid('one'), sectionId: null, beforeSessionId: sid('one') }),
    ]
    for (const operation of rejected) {
      expect(operation()).toMatchObject({ ok: false })
      expect(model.snapshot()).toEqual(prior)
    }
    model.removeWorkspace(wid('a'))
    expect(model.commit().sections[0]?.workspaceIds).toEqual([])
  })

  it('propagates a failed fixture publisher', () => {
    const failure = new Error('publisher failed')
    const model = createFixtureSections([], () => 'ordinary', () => { throw failure })
    expect(() => model.createSection({ title: 'First' })).toThrow(failure)
  })
})
