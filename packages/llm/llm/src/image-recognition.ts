/** Provider-neutral image-recognition service used by text-only model routes. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from './brand.ts'
import { HarnessError } from './error.ts'

/** Exact provider route used for auxiliary image recognition. */
export interface ImageRecognitionTarget {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** One image occurrence inside a source message. */
export interface ImageRecognitionImage {
  /** Durable normalized image reference. */
  attachment: ImageAttachmentRef
  /** Dot-separated block indexes locating the occurrence in the source message. */
  path: string
}

/** One source-message batch sent to an image-recognition provider. */
export interface ImageRecognitionBatch {
  /** Stable source message identity used for durable deduplication. */
  sourceMessageId: MessageId
  /** Session identity for replay routing; direct callers may omit it. */
  sessionId?: Branded<'SessionId'>
  /** Text from the same message, without conversation history. */
  associatedText: string
  /** Image occurrences in content order. */
  images: readonly ImageRecognitionImage[]
}

/** Successful recognition output and the exact route that produced it. */
export interface ImageRecognitionResult {
  /** Route captured for this auxiliary request. */
  target: ImageRecognitionTarget
  /** Plain factual report supplied to the text-only model. */
  text: string
}

/** Stable image-recognition failure classes. */
export type ImageRecognitionErrorCode =
  | 'IMAGE_RECOGNITION_MODEL_UNAVAILABLE'
  | 'IMAGE_RECOGNITION_MODEL_NOT_IMAGE_CAPABLE'
  | 'IMAGE_RECOGNITION_FAILED'
  | 'IMAGE_RECOGNITION_INCOMPLETE'

/** Failure raised by target validation or an auxiliary recognition call. */
export class ImageRecognitionError extends HarnessError {
  /**
   * @param message - actionable failure text.
   * @param code - stable image-recognition failure class.
   * @param options - optional underlying provider or adapter failure.
   */
  constructor(message: string, code: ImageRecognitionErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ImageRecognitionError'
  }
}

/** Durable source fields that hide the context in Chat and prevent reprocessing. */
export interface ImageRecognitionMessageSource {
  kind: 'image-recognition'
  /** Source message whose image batch was analyzed. */
  sourceMessageId: MessageId
  /** Exact visual route that generated the report. */
  provider: string
  model: string
  /** Every image occurrence covered by the report. */
  images: readonly {
    attachmentId: ImageAttachmentRef['attachmentId']
    path: string
  }[]
}

declare module './message.ts' {
  interface MessageSourceMap {
    /** Hidden, durable image information produced for a text-only route. */
    'image-recognition': ImageRecognitionMessageSource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional visual analysis used when the active model accepts text only. */
    imageRecognition: ImageRecognition
  }
}

/** Service Definition for auxiliary image recognition. */
export abstract class ImageRecognition extends Service {
  constructor(ctx: Context) {
    super(ctx, 'imageRecognition')
  }

  /**
   * Resolve and validate the configured image-recognition route.
   * @param signal - operation cancellation.
   * @returns a detached exact route, or `undefined` when recognition is not configured.
   */
  abstract resolveTarget(signal?: AbortSignal): Promise<ImageRecognitionTarget | undefined>

  /**
   * Analyze one source-message image batch.
   * @param batch - associated source text and ordered durable image occurrences.
   * @param signal - operation cancellation.
   * @returns the plain report and exact visual route.
   */
  abstract recognize(batch: ImageRecognitionBatch, signal?: AbortSignal): Promise<ImageRecognitionResult>
}

/**
 * Test whether the current deployment has a verified image-recognition route.
 * @param ctx - context carrying the optional image-recognition service.
 * @param signal - operation cancellation.
 * @returns true only when a configured exact model currently declares image input.
 * @throws {ImageRecognitionError} when a configured target is invalid or unavailable.
 */
export async function hasImageRecognitionTarget(ctx: Context, signal?: AbortSignal): Promise<boolean> {
  const service = ctx.get('imageRecognition')
  return service !== undefined && await service.resolveTarget(signal) !== undefined
}
