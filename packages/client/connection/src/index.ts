/** Transport-neutral Host Connection registry and shared protocol exports. */
import type { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from './rpc-host.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** The registry has no physical-carrier dependency. */
export const inject: string[] = []

/**
 * Provide the Host Connection registry. Physical carriers bind through a
 * sibling adapter such as `@deepseek-ai/dsh-client-connection/web`.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  new HostConnectionService(ctx)
}
