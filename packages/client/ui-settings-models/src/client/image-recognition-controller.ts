/** Staged Models-page editor for the Host-owned image-recognition route. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Host settings namespace for the selected image-recognition model. */
export const IMAGE_RECOGNITION_NS = 'image-recognition'

/** Exact model route stored by the image-recognition setting. */
export interface ImageRecognitionRoute {
  provider: string
  model: string
}

/** Settings value exposed by the Host plugin. */
export interface ImageRecognitionSettings {
  model: ImageRecognitionRoute | null
}

/** One selectable visual route, including a stored route that disappeared. */
export interface ImageRecognitionCandidate extends ImageRecognitionRoute {
  key: string
  providerName: string
  modelName: string
  available: boolean
}

/** State rendered by the image-recognition card. */
export interface ImageRecognitionCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  conflicted: boolean
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogPartial: boolean
  candidates: readonly ImageRecognitionCandidate[]
  selectedKey: string
}

/**
 * Build a stable candidate identity that callers resolve by lookup and never parse.
 * @param route - exact provider/model route.
 * @returns opaque key for one route.
 */
export function imageRecognitionRouteKey(route: ImageRecognitionRoute): string {
  return JSON.stringify([route.provider, route.model])
}

function sameRoute(left: ImageRecognitionRoute | null, right: ImageRecognitionRoute | null): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

/**
 * Join explicit image-capability metadata with a possibly stale stored route.
 * @param groups - current model catalog grouped by provider.
 * @param stored - Host-confirmed route, including a route absent from the catalog.
 * @returns selectable visual routes plus the unavailable stored route when needed.
 */
export function imageRecognitionCandidates(
  groups: readonly ModelProviderGroup[],
  stored: ImageRecognitionRoute | null,
): ImageRecognitionCandidate[] {
  const candidates: ImageRecognitionCandidate[] = groups.flatMap(group => group.models.flatMap((model) => {
    if (model.inputModalities?.includes('image') !== true) return []
    const route = { provider: group.id, model: model.id }
    return [{
      ...route,
      key: imageRecognitionRouteKey(route),
      providerName: group.name,
      modelName: model.name,
      available: true,
    }]
  }))
  if (stored !== null && !candidates.some(candidate => sameRoute(candidate, stored))) {
    candidates.push({
      ...stored,
      key: imageRecognitionRouteKey(stored),
      providerName: stored.provider,
      modelName: stored.model,
      available: false,
    })
  }
  return candidates
}

/** Controller joining one settings namespace with the live model catalog. */
export class ImageRecognitionCardController {
  /** Reactive card projection consumed by the Models page. */
  readonly store: SnapshotStore<ImageRecognitionCardState>
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogStatus: ImageRecognitionCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private draft: ImageRecognitionRoute | null | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private catalogRequested = false
  private catalogGeneration = 0
  private saveGeneration = 0
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `image-recognition` settings namespace.
   * @param ctx - client context exposing the Session model catalog.
   */
  constructor(
    private readonly scope: SettingsScope<ImageRecognitionSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      const snapshot = scope.getSnapshot()
      if (!this.saving && this.draft !== undefined && snapshot.revision !== this.draftRevision) {
        if (sameRoute(this.current(), this.draft)) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
  }

  /** Stop observations and suppress late catalog or save settlements. */
  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Read the current Host-confirmed route used to protect provider capability edits.
   * @returns exact saved route, or `null` when recognition is disabled.
   */
  currentTarget(): ImageRecognitionRoute | null {
    return this.current()
  }

  /** Load the model catalog once the card is rendered. */
  ensureCatalog(): void {
    this.catalogRequested = true
    if (this.catalogStatus === 'idle') void this.loadCatalog()
  }

  /** Retry a failed catalog read. */
  retryCatalog(): void {
    if (this.catalogStatus !== 'loading') void this.loadCatalog()
  }

  /**
   * Stage an available candidate key, or the empty disabled selection.
   * @param key - opaque candidate key, or an empty string to disable recognition.
   */
  select(key: string): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const next = key === ''
      ? null
      : this.candidates().find(candidate => candidate.key === key && candidate.available)
    if (next === undefined) return
    if (this.draft === undefined) this.draftRevision = snapshot.revision
    this.draft = next === null ? null : { provider: next.provider, model: next.model }
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  /** Discard a staged route. */
  discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  /** Persist the staged route through one revision-fenced mutation. */
  save(): void {
    void this.commit()
  }

  /** Invalidate exact model metadata after provider settings or topology changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    if (this.catalogRequested) void this.loadCatalog()
    this.publish()
  }

  /** Reset Host-specific state after connection replacement. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    this.refreshCatalog()
  }

  private current(): ImageRecognitionRoute | null {
    return this.scope.getSnapshot().value?.model ?? null
  }

  private desired(): ImageRecognitionRoute | null {
    return this.draft === undefined ? this.current() : this.draft
  }

  private clearDraft(): void {
    this.draft = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private candidates(): ImageRecognitionCandidate[] {
    return imageRecognitionCandidates(this.catalogGroups, this.current())
  }

  private async commit(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desired = this.desired()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || sameRoute(this.current(), desired) || this.isInvalid(desired)) return
    if (this.draft !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    await this.scope.mutate([{
      op: 'set',
      path: ['model'],
      value: desired === null ? null : { provider: desired.provider, model: desired.model },
    }], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = sameRoute(this.current(), desired)
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  private isInvalid(route: ImageRecognitionRoute | null): boolean {
    if (route === null || this.catalogStatus !== 'ready') return false
    return !this.candidates().some(candidate => candidate.available && sameRoute(candidate, route))
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = ++this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.catalogGroups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): ImageRecognitionCardState {
    const snapshot = this.scope.getSnapshot()
    const desired = this.desired()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: !sameRoute(this.current(), desired),
      invalid: this.isInvalid(desired),
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      candidates: this.candidates(),
      selectedKey: desired === null ? '' : imageRecognitionRouteKey(desired),
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
