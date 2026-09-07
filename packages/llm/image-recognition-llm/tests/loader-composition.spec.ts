/** Real Loader composition for durable text-route image recognition. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as ImageRecognitionLlm from '@deepseek-ai/dsh-image-recognition-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

let root: string | undefined
let context: Context | undefined

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly modalities: readonly ModelModality[],
    private readonly text: string,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: [...this.modalities] })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-image-recognition-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-image-recognition-llm'",
    '  config:',
    '    model:',
    '      provider: vision',
    '      model: visual-model',
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-image-recognition-llm', ImageRecognitionLlm],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('image-recognition-llm real Loader composition', () => {
  it('loads the service and commits its report before a text-only model request', { timeout: 60_000 }, async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const vision = new ScriptedAdapter(['text', 'image'], 'Image 1\nA solid red square.')
    const primary = new ScriptedAdapter(['text'], 'RED')
    ctx.llm.registerAdapter(['vision'], vision)
    ctx.llm.registerAdapter(['text'], primary)
    const image: ImageAttachmentRef = {
      attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'red.png',
    }
    const agent = await ctx.agentLoop.create(
      SessionId('image-recognition-loader'),
      { provider: 'text', model: 'text-model' },
    )
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'What color is this?' }, { type: 'image', attachment: image }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(vision.requests).toHaveLength(1)
    expect(vision.requests[0]).toMatchObject({ purpose: 'image-recognition' })
    expect(vision.requests[0]).not.toHaveProperty('tools')
    expect(primary.requests).toHaveLength(1)
    expect(primary.requests[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      source: { kind: 'image-recognition', provider: 'vision', model: 'visual-model' },
    })
    expect(agent.session.deriveMessages().map(message => message.source.kind)).toEqual([
      'user', 'image-recognition', 'model',
    ])
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'RED' }])
  })
})
