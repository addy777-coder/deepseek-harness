/** Section placement validation and ordered edits for the Workspace registry's write queue. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceDomainState } from './spec.ts'
import type { SidebarSectionId } from './types.ts'

/**
 * Resolve a custom section in the current layout.
 * @param state - current registry state.
 * @param id - required section identity.
 * @returns the section, or throws a stable missing-section error.
 */
export function requireSection(state: WorkspaceDomainState, id: SidebarSectionId): WorkspaceDomainState['sections'][number] {
  const section = state.sections.find(candidate => candidate.id === id)
  if (section === undefined) {
    throw new RemoteError('workspace/section-not-found', `Sidebar section "${id}" not found`, { sectionId: id })
  }
  return section
}

/**
 * Resolve a unique non-blank section title.
 * @param state - current registry state.
 * @param input - proposed title.
 * @param id - section being renamed, when present.
 * @returns the trimmed title.
 */
export function sectionTitle(state: WorkspaceDomainState, input: string, id?: SidebarSectionId): string {
  const title = input.trim()
  if (title === '') throw invalidSection('A sidebar section requires a non-blank title')
  if (state.sections.some(section => section.id !== id && section.title === title)) {
    throw new RemoteError('workspace/section-name-conflict', `Sidebar section "${title}" already exists`, { title })
  }
  return title
}

/**
 * Insert an identity before an existing anchor, removing its previous position.
 * @param ids - destination account.
 * @param id - identity to insert.
 * @param before - destination anchor; omitted appends.
 * @returns the new account; an invalid anchor rejects without editing the input.
 */
export function insertSectionEntry<T extends string>(ids: readonly T[], id: T, before?: T): T[] {
  if (before !== undefined && !ids.includes(before)) throw invalidSection('The insertion anchor is outside the destination')
  if (before === id) return [...ids]
  const next = ids.filter(candidate => candidate !== id)
  next.splice(before === undefined ? next.length : next.indexOf(before), 0, id)
  return next
}

/**
 * Validate durable section identities, names, and one-placement membership.
 * @param state - decoded registry state.
 */
export function validateSections(state: WorkspaceDomainState): void {
  const sectionIds = new Set<SidebarSectionId>()
  const titles = new Set<string>()
  const workspaces = new Set<string>()
  const sessions = new Set<string>()
  for (const section of state.sections) {
    if (sectionIds.has(section.id) || titles.has(section.title)
      || section.title.trim() === '' || section.title !== section.title.trim()) {
      throw invalidSection('Stored sidebar sections contain duplicate identities or invalid titles')
    }
    sectionIds.add(section.id)
    titles.add(section.title)
    for (const id of section.workspaceIds) {
      if (!state.workspaceIds.includes(id) || workspaces.has(id)) {
        throw invalidSection(`Stored sidebar section references missing or repeated Workspace "${id}"`)
      }
      workspaces.add(id)
    }
    for (const id of section.sessionIds) {
      if (sessions.has(id)) throw invalidSection(`Stored sidebar sections repeat Session "${id}"`)
      sessions.add(id)
    }
  }
}

/**
 * Construct a stable section validation failure.
 * @param reason - invalid title or placement description.
 * @returns the Remote failure thrown by the registry.
 */
export function invalidSection(reason: string): RemoteError<'workspace/section-invalid'> {
  return new RemoteError('workspace/section-invalid', reason, { reason })
}
