/** Browser HTTP adapter for client startup injections and bundle artifacts. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './index.ts'

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** Stable Cordis plugin name. */
export const name = 'client-modules-web'

/** Services required by the browser carrier. */
export const inject = ['clientBoot', 'clientModules', 'webServer']

/**
 * Bind the transport-neutral client graph to the Web server.
 * @param ctx - Host context containing the graph, boot table, and Web server.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugins',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      /* v8 ignore next -- node:http always supplies a URL for server requests. */
      const requestUrl = new URL(req.url ?? '/', 'http://client-modules.invalid')
      const artifact = ctx.clientModules.artifact(`${requestUrl.pathname}${requestUrl.search}`)
      if (artifact === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': artifact.contentType,
        'cache-control': IMMUTABLE_CACHE,
      })
      res.end(req.method === 'HEAD' ? undefined : artifact.body)
    },
  }), 'client-modules-web: /plugins route')
  ctx.on('webserver/index-inject', (table) => {
    table.push(...ctx.clientBoot.collect())
  })
}
