/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SidebarSectionId, WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

/** Persisted section entries keep project and independent Session order separately. */
const sidebarSection = z.object({
  id: z.string().transform(value => brandString<SidebarSectionId>(value)),
  title: z.string().min(1),
  workspaceIds: z.array(workspaceId),
  sessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))),
})

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. Sections override navigation placement without changing Session accounting.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))),
  sections: z.array(sidebarSection),
  layoutRevision: z.number().int().nonnegative(),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
 * this through `ctx.storage.domain`; the spec object is the single source of
 * the domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 3,
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], sections: [], layoutRevision: 0 },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
