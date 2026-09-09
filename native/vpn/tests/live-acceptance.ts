/** Live pi-ai acceptance steps for an already connected desktop test composition. Importing this module performs no I/O. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-network'
import type {} from '@deepseek-ai/dsh-settings'

/** Explicit request budget and saved model selection for the live run. */
export interface LiveAcceptanceOptions {
  /** Existing pi-ai provider configured to use VPN and Anthropic Messages. */
  provider: string
  /** Existing model id under that provider. */
  model: string
  /** Deadline for each model call, including draining a cancelled stream. */
  requestTimeoutMs: number
  /** Maximum generated tokens in the long-response and cancellation calls. */
  maxTokens: number
  /** Minimum completed long-response characters required for acceptance. */
  minimumLongResponseChars: number
  /** Whether the company endpoint implements the protocol's model listing. */
  checkDiscovery: boolean
  /** Optional cancellation of the entire acceptance run. */
  signal?: AbortSignal
}

/** Counts only; no credential, endpoint, model output or provider error text is retained. */
export interface LiveAcceptanceReport {
  textDeltas: number
  toolCalls: number
  toolFollowupDeltas: number
  longResponseDeltas: number
  longResponseChars: number
  cancellation: 'passed'
  discovery: 'passed' | 'not-requested'
  discoveredModels: number
}

class AcceptanceFailure extends Error {}

function assertLive(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AcceptanceFailure(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ask(text: string): Message[] {
  return [createUserMessage({ source: { kind: 'plugin', plugin: 'vpn-live-acceptance' }, content: [{ type: 'text', text }] })]
}

/**
 * Exercise saved credential resolution, pi-ai Anthropic streaming, tool replay, long output and cancellation.
 * The caller explicitly starts a desktop test composition with the production services and calls this only after
 * the user has saved VPN/model credentials and connected. This function neither connects/disconnects a VPN nor writes settings.
 * @param ctx - initialized network, llm, settings and credential services using the desktop's saved records.
 * @param options - saved model selection and bounded request budget; never accepts a password or API key.
 * @returns sanitized acceptance counters; rejects with a fixed failure code without upstream response text.
 */
export async function runLiveAcceptance(ctx: Context, options: LiveAcceptanceOptions): Promise<LiveAcceptanceReport> {
  let stage = 'VPN_LIVE_PREFLIGHT_FAILED'
  try {
    assertLive(process.platform === 'win32' && process.arch === 'x64', 'VPN_LIVE_PLATFORM_UNSUPPORTED')
    assertLive(Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs >= 1000
      && Number.isSafeInteger(options.maxTokens) && options.maxTokens >= 1024
      && Number.isSafeInteger(options.minimumLongResponseChars) && options.minimumLongResponseChars >= 1024,
    'VPN_LIVE_BUDGET_INVALID')
    const assertRoute = (): Record<string, unknown> => {
      const settings = ctx.settings.get('llm-pi-ai')
      assertLive(record(settings) && record(settings.providers), 'VPN_LIVE_SAVED_PROVIDER_MISSING')
      const profile = settings.providers[options.provider]
      assertLive(record(profile) && profile.network === 'vpn' && profile.api === 'anthropic-messages'
        && typeof profile.baseURL === 'string', 'VPN_LIVE_SAVED_ROUTE_INVALID')
      assertLive(profile.apiKey === undefined, 'VPN_LIVE_MODEL_KEY_MUST_USE_CREDENTIAL_SERVICE')
      return profile
    }
    const profile = assertRoute()
    const state = await ctx.network.get()
    assertLive(state.connection === 'connected' && state.passwordConfigured, 'VPN_LIVE_REQUIRES_CONNECTED_SAVED_PROFILE')
    if (typeof profile.apiKeyEnv === 'string') {
      const credential = await ctx.credentials.describe(credentialRef(profile.apiKeyEnv))
      assertLive(credential.configured && credential.source !== 'env', 'VPN_LIVE_SAVED_MODEL_CREDENTIAL_MISSING')
    } else {
      const credential = await ctx.credentials.describeRecord(credentialKey('llm-pi-ai', options.provider))
      assertLive(credential.configured, 'VPN_LIVE_SAVED_MODEL_CREDENTIAL_MISSING')
    }

    const run = async (messages: Message[], extra: Partial<GenerateOptions> = {}, cancelOnText = false) => {
      assertRoute()
      assertLive((await ctx.network.get()).connection === 'connected', 'VPN_LIVE_CONNECTION_LOST')
      const cancel = new AbortController()
      const deadline = AbortSignal.timeout(options.requestTimeoutMs)
      const signal = AbortSignal.any([cancel.signal, deadline, ...options.signal ? [options.signal] : []])
      const assembler = new BlockAssembler()
      let textDeltas = 0
      let chars = 0
      let finishes = 0
      const request: GenerateOptions = { provider: options.provider, model: options.model,
        messages, maxTokens: options.maxTokens, ...extra, signal }
      for await (const chunk of ctx.llm.stream(request)) {
        assertLive(finishes === 0, 'VPN_LIVE_EVENT_AFTER_FINISH')
        assembler.push(chunk)
        if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          textDeltas++
          chars += chunk.text.length
          if (cancelOnText) cancel.abort()
        }
        if (chunk.type === 'finish') finishes++
      }
      assertLive(!deadline.aborted && !options.signal?.aborted, 'VPN_LIVE_REQUEST_DEADLINE_OR_CANCELLATION')
      assertLive(finishes === 1, 'VPN_LIVE_TERMINAL_EVENT_MISSING')
      return { assembler, textDeltas, chars }
    }

    stage = 'VPN_LIVE_TEXT_FAILED'
    const text = await run(ask('Reply with exactly VPN_NATIVE_OK.'), { maxTokens: 128 })
    assertLive(text.textDeltas > 0 && text.assembler.finish.kind === 'stop', stage)
    assertLive(text.assembler.blocks().some(block => block.type === 'text' && block.text.includes('VPN_NATIVE_OK')), stage)

    stage = 'VPN_LIVE_TOOL_CALL_FAILED'
    const tools = [{ name: 'vpn_echo', description: 'Return the provided synthetic test value.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }]
    const toolMessages = ask('Call vpn_echo exactly once with value "vpn-tool-roundtrip". After receiving the result, reply with that result.')
    const tool = await run(toolMessages, { tools, maxTokens: 512 })
    const calls = tool.assembler.blocks().filter(block => block.type === 'tool-call')
    assertLive(calls.length === 1 && tool.assembler.finish.kind === 'tool-calls', stage)
    const call = calls[0]!
    const argumentsValue: unknown = JSON.parse(call.arguments)
    assertLive(call.name === 'vpn_echo' && record(argumentsValue) && argumentsValue.value === 'vpn-tool-roundtrip', stage)
    const assistant = tool.assembler.message({ kind: 'model', provider: options.provider, model: options.model,
      ...tool.assembler.replayState === undefined ? {} : { replayState: tool.assembler.replayState } })
    stage = 'VPN_LIVE_TOOL_REPLAY_FAILED'
    const followup = await run([...toolMessages, assistant, createToolResultMessage({ callId: call.id,
      content: [{ type: 'text', text: 'vpn-tool-roundtrip' }], isError: false })], { tools, maxTokens: 512 })
    assertLive(followup.textDeltas > 0 && followup.assembler.finish.kind === 'stop', stage)
    assertLive(followup.assembler.blocks().some(block => block.type === 'text' && block.text.includes('vpn-tool-roundtrip')), stage)

    const longPrompt = 'Write 200 numbered lines. Every line must contain: This synthetic response verifies streaming over the application VPN tunnel. Write every line in full without shortcuts. End with VPN_LONG_DONE.'
    stage = 'VPN_LIVE_LONG_RESPONSE_FAILED'
    const long = await run(ask(longPrompt))
    assertLive(long.textDeltas > 1 && long.chars >= options.minimumLongResponseChars
      && long.assembler.finish.kind === 'stop', stage)
    assertLive(long.assembler.blocks().some(block => block.type === 'text' && block.text.includes('VPN_LONG_DONE')), stage)

    stage = 'VPN_LIVE_STREAM_CANCELLATION_FAILED'
    const cancelled = await run(ask(longPrompt), {}, true)
    assertLive(cancelled.textDeltas > 0 && cancelled.assembler.finish.kind === 'aborted', stage)
    stage = 'VPN_LIVE_POST_CANCELLATION_FAILED'
    const afterCancellation = await run(ask('Reply with exactly VPN_NATIVE_OK.'), { maxTokens: 128 })
    assertLive(afterCancellation.textDeltas > 0 && afterCancellation.assembler.finish.kind === 'stop', stage)

    let discoveredModels = 0
    if (options.checkDiscovery) {
      stage = 'VPN_LIVE_DISCOVERY_FAILED'
      const signal = AbortSignal.any([AbortSignal.timeout(options.requestTimeoutMs), ...options.signal ? [options.signal] : []])
      const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: options.provider,
        network: 'vpn', api: 'anthropic-messages', baseURL: profile.baseURL as string }, signal)
      discoveredModels = models.length
      assertLive(discoveredModels > 0, stage)
    }
    assertRoute()
    return { textDeltas: text.textDeltas, toolCalls: calls.length, toolFollowupDeltas: followup.textDeltas,
      longResponseDeltas: long.textDeltas, longResponseChars: long.chars, cancellation: 'passed',
      discovery: options.checkDiscovery ? 'passed' : 'not-requested', discoveredModels }
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error
    throw new AcceptanceFailure(stage)
  }
}
