/** Deferred VPN Remote responses controlled independently of cancellation. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { VpnRemote } from '../src/client/model.ts'
import type { SaveVpnRequest, VpnSettingsView } from '../src/types.ts'
import { view } from './fixture.ts'

export { request, view } from './fixture.ts'

export class FakeVpnRemote implements VpnRemote {
  readonly calls: Array<{
    method: string
    signal: AbortSignal | undefined
    request: SaveVpnRequest | undefined
    result: PromiseWithResolvers<RemoteResult<VpnSettingsView>>
  }> = []

  get(signal?: AbortSignal) { return this.call('get', signal) }
  connect(signal?: AbortSignal) { return this.call('connect', signal) }
  disconnect(signal?: AbortSignal) { return this.call('disconnect', signal) }
  saveAndConnect(request: SaveVpnRequest, signal?: AbortSignal) { return this.call('save', signal, request) }

  settleAll(): void {
    for (const call of this.calls) call.result.resolve({ ok: true, value: view() })
  }

  private call(method: string, signal: AbortSignal | undefined, request?: SaveVpnRequest) {
    const result = Promise.withResolvers<RemoteResult<VpnSettingsView>>()
    this.calls.push({ method, signal, request, result })
    return result.promise
  }
}
