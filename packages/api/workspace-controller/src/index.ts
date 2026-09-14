/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import type { WorkspaceLayout } from '@deepseek-ai/dsh-workspace/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed } from './feed.ts'
import type {
  SidebarSectionCreateRequest, SidebarSectionCreateValue, SidebarSectionRenameRequest,
  SidebarSectionRequest, SidebarSectionInsertBeforeRequest, WorkspaceSectionMoveRequest,
  SessionSectionMoveRequest,
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry']

  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Append a custom sidebar section after validating its title.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout and created section identity.
   */
  @Remote('createSection')
  createSection(request: SidebarSectionCreateRequest): Promise<SidebarSectionCreateValue> {
    return this.commands.createSection(request)
  }

  /**
   * Rename a custom sidebar section.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout.
   */
  @Remote('renameSection')
  renameSection(request: SidebarSectionRenameRequest): Promise<WorkspaceLayout> {
    return this.commands.renameSection(request)
  }

  /**
   * Remove a section and restore its entries to their default placement.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout.
   */
  @Remote('deleteSection')
  deleteSection(request: SidebarSectionRequest): Promise<WorkspaceLayout> {
    return this.commands.deleteSection(request)
  }

  /**
   * Reorder custom sections without changing their entries.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout.
   */
  @Remote('insertSectionBefore')
  insertSectionBefore(request: SidebarSectionInsertBeforeRequest): Promise<WorkspaceLayout> {
    return this.commands.insertSectionBefore(request)
  }

  /**
   * Move a project into a section or back into the default project area.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout.
   */
  @Remote('moveWorkspaceToSection')
  moveWorkspaceToSection(request: WorkspaceSectionMoveRequest): Promise<WorkspaceLayout> {
    return this.commands.moveWorkspaceToSection(request)
  }

  /**
   * Move an independent Session entry while preserving its working directory.
   * @param request - section identity, title, or destination and optional insertion anchor.
   * @returns the committed layout.
   */
  @Remote('moveSessionToSection')
  moveSessionToSection(request: SessionSectionMoveRequest): Promise<WorkspaceLayout> {
    return this.commands.moveSessionToSection(request)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }
}

export default WorkspaceController
