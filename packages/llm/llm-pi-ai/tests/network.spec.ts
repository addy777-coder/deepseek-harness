/** VPN isolation through the real pi-ai Anthropic SDK and model discovery. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import type { NetworkTarget, NetworkTargetId } from '@deepseek-ai/dsh-network'
import * as LlmPiAi from '../src/index.ts'
import { assertServiceable, resolveProfiles } from '../src/config.ts'
import { discoverModels } from '../src/discovery.ts'
import { assemble } from './assemble.ts'

const BASE = 'https://company.invalid/model-api'
const profile: LlmPiAi.PiAiProviderProfile = {
  api: 'anthropic-messages', baseURL: BASE, network: 'vpn', apiKeyEnv: 'VPN_TEST_KEY',
  models: [{ id: 'company-model' }],
}
const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** An in-memory tunnel whose requests cannot reach host networking. */
class NetworkDouble extends Service {
  targets = new Map<NetworkTargetId, NetworkTarget>()
  dispatch = vi.fn<typeof globalThis.fetch>()

  constructor(ctx: Context) { super(ctx, 'network') }

  registerTarget(id: NetworkTargetId, target: NetworkTarget): () => void {
    this.targets.set(id, target)
    return () => { this.targets.delete(id) }
  }

  fetch(id: NetworkTargetId, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.targets.has(id)) return Promise.reject(new Error('VPN target is not registered'))
    return this.dispatch(input, init)
  }
}

/** A complete Anthropic streamed tool invocation. */
function toolResponse(): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_company', type: 'message', role: 'assistant', content: [], model: 'company-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_company', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"private"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function mount(network = true): Promise<{ ctx: Context; tunnel?: NetworkDouble }> {
  vi.stubEnv('VPN_TEST_KEY', 'company-key')
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('direct networking is forbidden') }))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const tunnel = network ? new NetworkDouble(ctx) : undefined
  await ctx.plugin(LlmPiAi, { providers: { company: profile } })
  return { ctx, ...tunnel === undefined ? {} : { tunnel } }
}

describe('VPN provider configuration', () => {
  it('defaults existing routes to direct and accepts the HTTP VPN profile', () => {
    const direct = { ...profile }
    delete direct.network
    expect(resolveProfiles({ direct }).get('direct')?.network).toBe('direct')
    expect(() => { assertServiceable({ providers: { company: profile } }) }).not.toThrow()
  })

  it.each([
    [{ api: 'openai-responses' }, /anthropic-messages/],
    [{ api: undefined }, /api/],
    [{ baseURL: undefined }, /baseURL/],
    [{ baseURL: 'https://user:secret@company.invalid' }, /without credentials/],
    [{ apiKeyEnv: undefined }, /credential reference/],
    [{ transport: 'websocket' }, /sse streaming transport/],
    [{ transport: 'auto' }, /sse streaming transport/],
  ] as const)('refuses a VPN profile that could escape its HTTP route: %o', (override, message) => {
    const candidate = Object.fromEntries(Object.entries({ ...profile, ...override })
      .filter(([, value]) => value !== undefined)) as LlmPiAi.PiAiProviderProfile
    expect(() => { assertServiceable({ providers: { company: candidate } }) }).toThrow(message)
  })
})

describe('VPN provider dispatch', () => {
  it('registers only current VPN destinations across settings changes and service detach', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-consumer-'))
    directories.push(directory)
    const { ctx } = await mount(false)
    await ctx.plugin(FileSettingsProvider, { path: join(directory, 'settings.yaml'), watch: false })
    const fiber = await ctx.plugin(NetworkDouble)
    const tunnel = ctx.network as unknown as NetworkDouble
    expect([...tunnel.targets.values()]).toEqual([{ baseURL: BASE }])
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'company', 'baseURL'], value: `${BASE}/other` }])
    expect([...tunnel.targets.values()]).toEqual([{ baseURL: `${BASE}/other` }])
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'company', 'network'], value: 'direct' }])
    expect(tunnel.targets.size).toBe(0)
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'company', 'network'], value: 'vpn' }])
    expect(tunnel.targets.size).toBe(1)
    await fiber.dispose()
    expect(tunnel.targets.size).toBe(0)
    await expect(assemble(ctx, { provider: 'company', model: 'company-model', messages: [] }))
      .resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'VPN_UNAVAILABLE' } } })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('preserves the endpoint, streams tool arguments, and never calls global fetch', async () => {
    const { ctx, tunnel } = await mount()
    tunnel!.dispatch.mockResolvedValueOnce(toolResponse())
    const result = await assemble(ctx, { provider: 'company', model: 'company-model', messages: [],
      tools: [{ name: 'lookup', description: 'Find a record', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
    })
    expect(result.message.content).toContainEqual({ type: 'tool-call', id: 'tool_company', name: 'lookup', arguments: '{"query":"private"}' })
    expect(tunnel!.dispatch).toHaveBeenCalledTimes(1)
    const [input, init] = tunnel!.dispatch.mock.calls[0]!
    expect(input instanceof Request ? input.url : input.toString()).toBe(`${BASE}/v1/messages`)
    expect(new Headers(init?.headers).get('x-api-key')).toBe('company-key')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect([...tunnel!.targets.values()]).toEqual([{ baseURL: BASE }])
    await ctx.fiber.dispose()
    expect(tunnel!.targets.size).toBe(0)
  })

  it('fails before sending a request when the VPN service is unavailable', async () => {
    const { ctx } = await mount(false)
    await expect(assemble(ctx, { provider: 'company', model: 'company-model', messages: [] }))
      .resolves.toMatchObject({ finish: { kind: 'error', failure: { code: 'VPN_UNAVAILABLE' } } })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('uses the same registered target for authenticated Anthropic model discovery', async () => {
    const { ctx, tunnel } = await mount()
    tunnel!.dispatch.mockResolvedValueOnce(Response.json({ data: [{ id: 'company-model', display_name: 'Company Model' }] }))
    const models = await ctx.llm.discoverModels('llm-pi-ai', {
      provider: 'company', baseURL: BASE, api: 'anthropic-messages', network: 'vpn',
    })
    expect(models).toEqual([{ id: 'company-model', name: 'Company Model' }])
    const [url, init] = tunnel!.dispatch.mock.calls[0]!
    expect(url).toBe(`${BASE}/v1/models`)
    expect(new Headers(init?.headers).get('x-api-key')).toBe('company-key')
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('cancels a pending VPN request with the model operation', async () => {
    const { ctx, tunnel } = await mount()
    const started = Promise.withResolvers<AbortSignal>()
    tunnel!.dispatch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal == null) throw new Error('missing request signal')
      started.resolve(signal)
      signal.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')) }, { once: true })
    }))
    const caller = new AbortController()
    const pending = assemble(ctx, { provider: 'company', model: 'company-model', messages: [], signal: caller.signal })
    const signal = await started.promise
    caller.abort()
    await pending
    expect(signal.aborted).toBe(true)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('refuses unsaved destinations and direct discovery overrides of a VPN provider', async () => {
    const { ctx, tunnel } = await mount()
    for (const override of [{ baseURL: 'https://other.invalid' }, { network: 'direct' as const }]) {
      await expect(ctx.llm.discoverModels('llm-pi-ai', {
        provider: 'company', baseURL: BASE, api: 'anthropic-messages', network: 'vpn', ...override,
      })).rejects.toThrow(/save/)
    }
    await expect(discoverModels({ baseURL: BASE, api: 'anthropic-messages', network: 'vpn' })).rejects.toThrow(/save/)
    expect(tunnel!.dispatch).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
