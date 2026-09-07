import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, {
  ImageRecognitionError,
  LlmAdapter,
  ToolCallId,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ImageRecognitionLlm, {
  IMAGE_RECOGNITION_SYSTEM_PROMPT,
  pendingImageRecognitionBatches,
} from '@deepseek-ai/dsh-image-recognition-llm'

const IMAGE: ImageAttachmentRef = {
  attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
  mediaType: 'image/png',
  bytes: 10,
  width: 2,
  height: 3,
  name: 'sample.png',
}

class MemorySettings extends SettingsProvider {
  override readonly writable = true
  private rawDocument: Record<string, unknown>

  constructor(ctx: Context, document: Record<string, unknown> = {}) {
    super(ctx)
    this.rawDocument = structuredClone(document)
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.rawDocument))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.rawDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function response(text: string, finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

class RouteAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly modalities: readonly ModelModality[],
    private readonly script: StreamChunk[][],
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: [...this.modalities] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('route adapter script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

class HangingVisionAdapter extends LlmAdapter {
  readonly started = Promise.withResolvers<undefined>()
  settled = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.started.resolve(undefined)
    try {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          const reason = options.signal?.reason as unknown
          reject(reason instanceof Error ? reason : new Error('image recognition canceled'))
        }
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    } finally {
      this.settled = true
    }
  }
}

async function loopHarness(visionScript: StreamChunk[][], primaryScript: StreamChunk[][]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const vision = new RouteAdapter(['text', 'image'], visionScript)
  const primary = new RouteAdapter(['text'], primaryScript)
  ctx.llm.registerAdapter(['vision'], vision)
  ctx.llm.registerAdapter(['text'], primary)
  await ctx.plugin(ImageRecognitionLlm, { model: { provider: 'vision', model: 'vision-model' } })
  return { ctx, vision, primary }
}

describe('image recognition batches', () => {
  it('collects direct and nested images once per source message', () => {
    const direct = createUserMessage({
      content: [{ type: 'text', text: 'inspect this' }, { type: 'image', attachment: IMAGE }],
      source: { kind: 'user' },
    })
    const nested = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'tool envelope' }, { type: 'image', attachment: IMAGE }],
      }],
      source: { kind: 'tool', callId: ToolCallId('call-1') },
    })
    const marker = createUserMessage({
      content: [{ type: 'text', text: 'recognized' }],
      source: {
        kind: 'image-recognition',
        sourceMessageId: direct.id,
        provider: 'vision',
        model: 'vision-model',
        images: [{ attachmentId: IMAGE.attachmentId, path: '1' }],
      },
    })

    expect(pendingImageRecognitionBatches([direct, nested, marker])).toEqual([{
      sourceMessageId: nested.id,
      associatedText: 'tool envelope',
      images: [{ attachment: IMAGE, path: '0.1' }],
    }])
  })
})

describe('image recognition service', () => {
  it('follows the live image-recognition settings namespace', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const vision = new RouteAdapter(['text', 'image'], [])
    ctx.llm.registerAdapter(['vision'], vision)
    await ctx.plugin(MemorySettings, {
      'image-recognition': { model: { provider: 'vision', model: 'vision-model' } },
    })
    await ctx.plugin(ImageRecognitionLlm)

    await expect(ctx.imageRecognition.resolveTarget()).resolves.toEqual({
      provider: 'vision', model: 'vision-model',
    })
    await ctx.settings.update('image-recognition', { model: null })
    await expect(ctx.imageRecognition.resolveTarget()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('returns no target while unconfigured and rejects a text-only target', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const text = new RouteAdapter(['text'], [])
    ctx.llm.registerAdapter(['text'], text)
    await ctx.plugin(ImageRecognitionLlm)
    expect(await ctx.imageRecognition.resolveTarget()).toBeUndefined()
    await ctx.fiber.dispose()

    const configured = new Context()
    await configured.plugin(LlmRuntime)
    configured.llm.registerAdapter(['text'], text)
    await configured.plugin(ImageRecognitionLlm, { model: { provider: 'text', model: 'plain' } })
    await expect(configured.imageRecognition.resolveTarget()).rejects.toMatchObject({
      code: 'IMAGE_RECOGNITION_MODEL_NOT_IMAGE_CAPABLE',
    })
    await configured.fiber.dispose()
  })

  it('sends only associated text and ordered images, and refuses incomplete output', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const vision = new RouteAdapter(['text', 'image'], [response('red square'), response('partial', 'max-tokens')])
    ctx.llm.registerAdapter(['vision'], vision)
    await ctx.plugin(ImageRecognitionLlm, { model: { provider: 'vision', model: 'vision-model' } })
    const batch = {
      sourceMessageId: 'message-1' as never,
      associatedText: 'What color is it?',
      images: [{ attachment: IMAGE, path: '1' }],
    }

    await expect(ctx.imageRecognition.recognize(batch)).resolves.toEqual({
      target: { provider: 'vision', model: 'vision-model' },
      text: 'red square',
    })
    expect(vision.requests[0]).toMatchObject({
      provider: 'vision',
      model: 'vision-model',
      purpose: 'image-recognition',
      system: IMAGE_RECOGNITION_SYSTEM_PROMPT,
    })
    expect(vision.requests[0]?.messages).toHaveLength(1)
    expect(JSON.stringify(vision.requests[0]?.messages)).toContain('What color is it?')
    expect(vision.requests[0]?.messages[0]?.content.some(block => block.type === 'image')).toBe(true)
    await expect(ctx.imageRecognition.recognize(batch)).rejects.toMatchObject({
      code: 'IMAGE_RECOGNITION_INCOMPLETE',
    } satisfies Partial<ImageRecognitionError>)
    await expect(ctx.imageRecognition.recognize(batch)).rejects.toMatchObject({
      code: 'IMAGE_RECOGNITION_FAILED',
      message: 'image recognition failed: route adapter script exhausted',
    } satisfies Partial<ImageRecognitionError>)
    await ctx.fiber.dispose()
  })

  it('rejects empty text, tool calls, and cancellation without returning a report', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const vision = new RouteAdapter(['text', 'image'], [
      response('   '),
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'inspect', arguments: '{}' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    ])
    ctx.llm.registerAdapter(['vision'], vision)
    await ctx.plugin(ImageRecognitionLlm, { model: { provider: 'vision', model: 'vision-model' } })
    const batch = {
      sourceMessageId: 'message-1' as never,
      associatedText: '',
      images: [{ attachment: IMAGE, path: '0' }],
    }

    await expect(ctx.imageRecognition.recognize(batch)).rejects.toMatchObject({
      code: 'IMAGE_RECOGNITION_INCOMPLETE',
      message: 'image recognition model produced no text',
    } satisfies Partial<ImageRecognitionError>)
    await expect(ctx.imageRecognition.recognize(batch)).rejects.toMatchObject({
      code: 'IMAGE_RECOGNITION_INCOMPLETE',
      message: 'image recognition model unexpectedly requested a tool',
    } satisfies Partial<ImageRecognitionError>)
    const canceled = new AbortController()
    canceled.abort(new Error('recognition canceled'))
    await expect(ctx.imageRecognition.recognize(batch, canceled.signal)).rejects.toThrow('recognition canceled')
    expect(vision.requests).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('recognizes one source batch before text dispatch and reuses its durable context', async () => {
    const { ctx, vision, primary } = await loopHarness(
      [response('The image is a red square.')],
      [response('first answer'), response('second answer')],
    )
    const agent = await ctx.agentLoop.create(SessionId('image-recognition'), {
      provider: 'text', model: 'text-model',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'What is shown?' }, { type: 'image', attachment: IMAGE }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(vision.requests).toHaveLength(1)
    expect(primary.requests).toHaveLength(1)
    expect(primary.requests[0]?.messages.some(message => message.content.some(block => block.type === 'image')))
      .toBe(false)
    expect(JSON.stringify(primary.requests[0]?.messages)).toContain('The image is a red square.')
    const context = agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'image-recognition')
    expect(context).toBeDefined()
    const inputIndex = agent.session.snapshotEvents().findIndex(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    const contextIndex = agent.session.snapshotEvents().findIndex(event => event === context)
    const headerIndex = agent.session.snapshotEvents().findIndex(event => event.type === 'request/header')
    expect(inputIndex).toBeLessThan(contextIndex)
    expect(contextIndex).toBeLessThan(headerIndex)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(vision.requests).toHaveLength(1)
    expect(primary.requests).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('keeps the original image durable and skips text dispatch when recognition fails', async () => {
    const failure: StreamChunk[] = [{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'VISION_DOWN', message: 'vision unavailable' } },
    }]
    const { ctx, primary } = await loopHarness([failure], [response('must not run')])
    const agent = await ctx.agentLoop.create(SessionId('image-recognition-failure'), {
      provider: 'text', model: 'text-model',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'image', attachment: IMAGE }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(primary.requests).toHaveLength(0)
    expect(agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'image')))
      .toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'image-recognition')).toBe(false)
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
    await ctx.fiber.dispose()
  })

  it('aborts and drains an active recognition call before plugin disposal settles', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const vision = new HangingVisionAdapter()
    ctx.llm.registerAdapter(['vision'], vision)
    const fiber = ctx.plugin(ImageRecognitionLlm, { model: { provider: 'vision', model: 'vision-model' } })
    await fiber.await()
    const operation = ctx.imageRecognition.recognize({
      sourceMessageId: 'message-1' as never,
      associatedText: '',
      images: [{ attachment: IMAGE, path: '0' }],
    })
    await vision.started.promise

    const disposal = fiber.dispose()
    await expect(operation).rejects.toThrow(/disposed/)
    await disposal
    expect(vision.settled).toBe(true)
    await ctx.fiber.dispose()
  })
})
