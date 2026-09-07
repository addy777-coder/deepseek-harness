/** Authenticated node:http adapter for the browser Connection carrier. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
} from './rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser trust, session authentication, and launch URL owner. */
    webConnection: WebConnectionHandle
  }
}

/** Browser-only security operations shared by HTTP routes and Web startup. */
export interface WebConnectionHandle {
  /** Apply Host/Origin checks and browser-session authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection
  /** Authenticate an index request, owning token redirects and rejection responses. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean
  /** Add the current process token to a clean application URL. */
  authenticatedUrl(baseUrl: string): string
}

/** Browser trust and authentication service created by the Web carrier. */
export class WebConnectionService extends Service implements WebConnectionHandle {
  /**
   * @param ctx - Web carrier context.
   * @param trustedHosts - additional authorities accepted by the Host/Origin checks.
   * @param auth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly auth: BrowserAuth,
  ) {
    super(ctx, 'webConnection')
  }

  /** Apply the configured Host/Origin checks, then browser authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.auth.isAuthenticated(request) ? undefined : 401
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.auth.authorizeIndex(request, response)
  }

  /** Add this process's launch token to a clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.auth.authenticatedUrl(baseUrl)
  }
}

/** Stable Cordis plugin name. */
export const name = 'client-connection-web'

/** Services required by the browser HTTP carrier. */
export const inject = ['connection', 'credentials', 'webServer']

/** Headroom for RPC fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

/** Browser carrier configuration. */
export interface Config {
  /** Additional non-loopback authorities accepted by the Host/Origin checks. */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every browser RPC request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<Config> = z.object({
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection-web maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/**
 * Bind the Connection registry to authenticated HTTP routes.
 * @param ctx - Host context containing Connection, credentials, and Web server.
 * @param config - resolved browser transport configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const trustedHosts = config.trustedHosts ?? []
  const cookieMaxAgeDays = config.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)

  const connection = ctx.connection as HostConnectionService
  const auth = await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays)
  const webConnection = new WebConnectionService(ctx, trustedHosts, auth)
  ctx.effect(() => {
    const routes = new Map<string, () => void>()
    const mount = (channel: string, active: boolean): void => {
      if (!active) {
        routes.get(channel)?.()
        routes.delete(channel)
        return
      }
      if (routes.has(channel)) return
      const fetchHandler = channel === API_PATH
        ? connection.createSharedFetchHandler(API_PATH)
        : connection.createFetchHandler(channel)
      const route: WebRoute = {
        kind: 'prefix',
        path: channel,
        handler: async (req, res) => {
          const rejection = webConnection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          await bridge(req, res, fetchHandler, channel === API_PATH ? maxRequestBodyBytes : undefined)
        },
      }
      routes.set(channel, ctx.webServer.register(route))
    }
    mount(API_PATH, true)
    const stopObserving = connection.observeRpcChannels(mount)
    return () => {
      stopObserving()
      for (const dispose of routes.values()) dispose()
      routes.clear()
    }
  }, 'client-connection-web: browser carrier')

  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
