/** In-memory sidebar layout for the standalone UI fixture's Workspace Remote protocol. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConnectionRpcFailure, ConnectionRpcResult } from '../rpc.ts'

/** Fixture wire identity shared with its project records. */
export type FixtureWorkspaceId = Branded<'WorkspaceId'>
/** Fixture wire identity for a custom section. */
export type FixtureSectionId = Branded<'SidebarSectionId'>

/** Mutable ordering references; the fixture retains each complete original project record. */
export interface FixtureWorkspaceRef { workspaceId: FixtureWorkspaceId }
/** One independent navigation account in the fixture. */
export interface FixtureSection {
  id: FixtureSectionId
  title: string
  workspaceIds: FixtureWorkspaceId[]
  sessionIds: SessionId[]
}
/** Detached layout receipt carried by the fixture's baseline and layout increments. */
export interface FixtureWorkspaceLayout {
  readonly revision: number
  readonly workspaceIds: readonly FixtureWorkspaceId[]
  readonly sections: readonly FixtureSection[]
}

class PlacementFailure extends Error {
  constructor(readonly failure: ConnectionRpcFailure) { super(failure.message) }
}

/** The fixture's complete section command and publication face. */
interface FixtureSectionCommands {
  snapshot(): FixtureWorkspaceLayout
  commit(): FixtureWorkspaceLayout
  removeWorkspace(workspaceId: FixtureWorkspaceId): void
  createSection(request: { title: string }): ConnectionRpcResult<{ sectionId: FixtureSectionId; layout: FixtureWorkspaceLayout }>
  renameSection(request: { sectionId: FixtureSectionId; title: string }): ConnectionRpcResult<FixtureWorkspaceLayout>
  deleteSection(request: { sectionId: FixtureSectionId }): ConnectionRpcResult<FixtureWorkspaceLayout>
  insertSectionBefore(request: {
    sectionId: FixtureSectionId
    beforeSectionId?: FixtureSectionId
  }): ConnectionRpcResult<FixtureWorkspaceLayout>
  moveWorkspaceToSection(request: {
    workspaceId: FixtureWorkspaceId
    sectionId: FixtureSectionId | null
    beforeWorkspaceId?: FixtureWorkspaceId
  }): ConnectionRpcResult<FixtureWorkspaceLayout>
  moveSessionToSection(request: {
    sessionId: SessionId
    sectionId: FixtureSectionId | null
    beforeSessionId?: SessionId
  }): ConnectionRpcResult<FixtureWorkspaceLayout>
}

/**
 * Mirror section placement without importing the Host registry into a browser-only fixture.
 * @param workspaces - mutable fixture project order; records are reordered, never fabricated here.
 * @param knownSession - fixture Session classification; undefined means absent.
 * @param changed - publish one complete layout after an edit.
 * @returns section commands, layout snapshots, and hooks for existing project mutations.
 */
export function createFixtureSections(
  workspaces: FixtureWorkspaceRef[], knownSession: (id: SessionId) => 'ordinary' | 'subagent' | undefined,
  changed: (layout: FixtureWorkspaceLayout) => void,
): FixtureSectionCommands {
  let revision = 0
  let nextId = 1
  let sections: FixtureSection[] = []
  const key = (): string => JSON.stringify([workspaces.map(workspace => workspace.workspaceId), sections])
  let committedKey = key()
  const snapshot = (): FixtureWorkspaceLayout => ({
    revision, workspaceIds: workspaces.map(workspace => workspace.workspaceId),
    sections: sections.map(section => ({ ...section, workspaceIds: [...section.workspaceIds], sessionIds: [...section.sessionIds] })),
  })
  const commit = (): FixtureWorkspaceLayout => {
    const next = key()
    if (next !== committedKey) {
      committedKey = next
      revision++
      changed(snapshot())
    }
    return snapshot()
  }
  const invalid = (reason: string): never => {
    throw new PlacementFailure({ code: 'workspace/section-invalid', message: reason, details: { reason } })
  }
  const requireSection = (sectionId: FixtureSectionId): FixtureSection => {
    const section = sections.find(item => item.id === sectionId)
    if (section === undefined) {
      throw new PlacementFailure({ code: 'workspace/section-not-found', message: `No section ${sectionId}`, details: { sectionId } })
    }
    return section
  }
  const title = (value: string, id?: FixtureSectionId): string => {
    const trimmed = value.trim()
    if (trimmed === '') return invalid('A section requires a non-blank title')
    if (sections.some(section => section.id !== id && section.title === trimmed)) {
      throw new PlacementFailure({ code: 'workspace/section-name-conflict', message: `Section ${trimmed} already exists`, details: { title: trimmed } })
    }
    return trimmed
  }
  const insert = <T extends string>(ids: readonly T[], id: T, before?: T): T[] => {
    if (before !== undefined && !ids.includes(before)) return invalid('Anchor is outside the destination')
    if (before === id) return [...ids]
    const next = ids.filter(candidate => candidate !== id)
    next.splice(before === undefined ? next.length : next.indexOf(before), 0, id)
    return next
  }
  const result = <T>(operation: () => T): ConnectionRpcResult<T> => {
    try { return { ok: true, value: operation() } } catch (error) {
      if (!(error instanceof PlacementFailure)) throw error
      return { ok: false, error: error.failure }
    }
  }
  const removeWorkspace = (workspaceId: FixtureWorkspaceId): void => {
    for (const section of sections) section.workspaceIds = section.workspaceIds.filter(id => id !== workspaceId)
  }
  return {
    snapshot, commit, removeWorkspace,
    createSection: request => result(() => {
      const resolved = title(request.title)
      const sectionId = `fx-section-${nextId++}` as FixtureSectionId
      sections.push({ id: sectionId, title: resolved, workspaceIds: [], sessionIds: [] })
      return { sectionId, layout: commit() }
    }),
    renameSection: request => result(() => {
      const section = requireSection(request.sectionId)
      section.title = title(request.title, section.id)
      return commit()
    }),
    deleteSection: request => result(() => {
      const section = requireSection(request.sectionId)
      const records = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]))
      const retained = workspaces.filter(workspace => !section.workspaceIds.includes(workspace.workspaceId))
      const restored = section.workspaceIds.map(id => records.get(id) as FixtureWorkspaceRef)
      workspaces.splice(0, workspaces.length, ...retained, ...restored)
      sections = sections.filter(candidate => candidate.id !== section.id)
      return commit()
    }),
    insertSectionBefore: request => result(() => {
      requireSection(request.sectionId)
      const byId = new Map(sections.map(section => [section.id, section]))
      sections = insert([...byId.keys()], request.sectionId, request.beforeSectionId).map(id => byId.get(id) as FixtureSection)
      return commit()
    }),
    moveWorkspaceToSection: request => result(() => {
      const workspace = workspaces.find(item => item.workspaceId === request.workspaceId)
      if (workspace === undefined) {
        throw new PlacementFailure({ code: 'workspace/not-found', message: `No workspace ${request.workspaceId}`, details: { workspaceId: request.workspaceId } })
      }
      const target = request.sectionId === null ? undefined : requireSection(request.sectionId)
      const assigned = new Set(sections.flatMap(section => section.workspaceIds))
      const ids = target?.workspaceIds ?? workspaces.filter(item => !assigned.has(item.workspaceId)).map(item => item.workspaceId)
      const next = insert(ids, workspace.workspaceId, request.beforeWorkspaceId)
      if (request.beforeWorkspaceId === workspace.workspaceId) return snapshot()
      removeWorkspace(workspace.workspaceId)
      if (target === undefined) {
        const records = new Map(workspaces.map(item => [item.workspaceId, item]))
        const order = insert([...records.keys()], workspace.workspaceId, request.beforeWorkspaceId)
        workspaces.splice(0, workspaces.length, ...order.map(id => records.get(id) as FixtureWorkspaceRef))
      } else target.workspaceIds = next
      return commit()
    }),
    moveSessionToSection: request => result(() => {
      const classification = knownSession(request.sessionId)
      if (classification === undefined) {
        throw new PlacementFailure({ code: 'session/not-found', message: `No ordinary session ${request.sessionId}`, details: { sessionId: request.sessionId } })
      }
      if (classification === 'subagent') return invalid('Subagent Sessions cannot be placed in sidebar sections')
      const target = request.sectionId === null ? undefined : requireSection(request.sectionId)
      if (target === undefined && request.beforeSessionId !== undefined) return invalid('Default placement has no Session anchor')
      const next = target === undefined ? [] : insert(target.sessionIds, request.sessionId, request.beforeSessionId)
      for (const section of sections) section.sessionIds = section.sessionIds.filter(id => id !== request.sessionId)
      if (target !== undefined) target.sessionIds = next
      return commit()
    }),
  }
}
