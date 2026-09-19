/** Session fixtures shared by the accounting and real-persistence tests. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'

export const NOW = Date.parse('2026-09-08T12:00:00Z')

export function event(type: string, data: unknown, time = NOW, seq = 0): SessionEvent {
  return { type, data, time, seq: SessionSeq(seq),
    ...type === 'user/message' || type === 'assistant/message' ? { surfaceOp: 'append' } : {},
  } as SessionEvent
}

export function user(time = NOW, text = 'hello'): SessionEvent {
  return event('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), time)
}

export function usage(totalTokens = 100): TokenUsage {
  return { inputTokens: totalTokens - 20, outputTokens: 20, totalTokens }
}

export function chunk(value: TokenUsage, time = NOW): SessionEvent {
  return attempt([{ type: 'chunk', time, chunk: { type: 'usage', usage: value } }], time)
}

export function attempt(stream: AssistantStreamRecord[], time = NOW): SessionEvent {
  return event('assistant/attempt', { turn: 1, step: 1, stream }, time)
}

export function message(value?: TokenUsage, time = NOW, model = 'flash', provider = 'deepseek', stream: AssistantStreamRecord[] = []): SessionEvent {
  return event('assistant/message', {
    turn: 1, step: 1,
    stream,
    message: { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider, model } },
    ...value === undefined ? {} : { usage: value },
  }, time)
}

export function header(id = 'session', extra: Partial<SessionHeader> = {}): SessionHeader {
  return { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: NOW - 86_400_000, isSeeded: false, ...extra }
}

export function observation(events: readonly SessionEvent[], meta = header(), inherited = 0): SessionObservation {
  const ordered = events.map((entry, seq) => ({ ...entry, seq: SessionSeq(seq) }))
  const value: SessionObservation = {
    source: 'live', header: meta, inheritedEventCount: SessionLogOffset(inherited), events: ordered,
    cursor: ordered.at(-1)?.seq ?? -1, retain: () => value, [Symbol.dispose]: () => {},
  }
  return value
}

export function turn(...middle: readonly SessionEvent[]): SessionEvent[] {
  return [
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('request/header', { reason: 'initial', header: { config: { provider: 'deepseek', model: 'flash' } } }),
    ...middle,
    event('step/end', { turn: 1, step: 1 }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].map((entry, seq) => ({ ...entry, seq: SessionSeq(seq) }))
}
