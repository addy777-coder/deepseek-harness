/** Strict DSH Desktop deep-link parsing. */

export type DesktopDeepLink =
  | { readonly kind: 'new' }
  | { readonly kind: 'session'; readonly sessionId: string }

const MAX_DEEP_LINK_LENGTH = 2048
const MAX_SESSION_ID_BYTES = 256

/** Encode one opaque Session id for a `dsh://session/` link. */
export function encodeSessionLink(sessionId: string): string {
  const encoded = Buffer.from(sessionId, 'utf8').toString('base64url')
  return `dsh://session/${encoded}`
}

/**
 * Parse the two supported deep-link forms and reject every extra component.
 * @param input - possible `dsh:` URL from process argv or a second instance.
 * @returns parsed intent, or undefined for an unsupported value.
 */
export function parseDesktopDeepLink(input: string): DesktopDeepLink | undefined {
  if (input.length === 0 || input.length > MAX_DEEP_LINK_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh:' || url.username !== '' || url.password !== ''
    || url.port !== '' || url.search !== '' || url.hash !== '') return undefined
  if (url.hostname === 'new' && (url.pathname === '' || url.pathname === '/')) return { kind: 'new' }
  if (url.hostname !== 'session') return undefined
  const match = /^\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (match?.[1] === undefined) return undefined
  let sessionId: string
  try {
    sessionId = Buffer.from(match[1], 'base64url').toString('utf8')
  } catch {
    return undefined
  }
  if (sessionId === '' || Buffer.byteLength(sessionId, 'utf8') > MAX_SESSION_ID_BYTES
    || Buffer.from(sessionId, 'utf8').toString('base64url') !== match[1]) return undefined
  return { kind: 'session', sessionId }
}

/** Return the first supported deep link in one Electron argv vector. */
export function deepLinkFromArgv(argv: readonly string[]): DesktopDeepLink | undefined {
  for (const argument of argv) {
    const parsed = parseDesktopDeepLink(argument)
    if (parsed !== undefined) return parsed
  }
  return undefined
}
