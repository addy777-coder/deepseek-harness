/** Import OpenVPN references from user-supplied files without opening Host paths. */
import { NetworkError, type VpnImportFile } from '@deepseek-ai/dsh-network'

const fileOptions = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs'])
const executableOptions = new Set(['config', 'plugin', 'up', 'down', 'route-up', 'ipchange', 'management', 'management-client', 'tls-verify'])

function tokens(line: string): string[] {
  const result: string[] = []
  let value = ''
  let quote = ''
  let active = false
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index)
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && (line[index + 1] === quote || line[index + 1] === '\\')) value += line.charAt(++index)
      else value += char
    } else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/u.test(char)) {
      if (active) { result.push(value); value = ''; active = false }
    } else if ((char === '#' || char === ';') && !active) break
    else { value += char; active = true }
  }
  if (quote) throw new NetworkError('VPN_PROFILE_SYNTAX')
  if (active) result.push(value)
  return result
}

function filename(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

/**
 * Inline referenced text certificates from a bounded import selection.
 * @param profile - authored OpenVPN text.
 * @param files - selected reference files, matched by unique filename.
 * @param maxBytes - complete UTF-8 import and resulting profile byte limit.
 * @returns self-contained profile text; executable hooks and missing references reject.
 */
export function importProfile(profile: VpnImportFile, files: readonly VpnImportFile[], maxBytes: number): string {
  if (files.length > 16 || profile.content.includes('\0')) throw new NetworkError('VPN_PROFILE_INVALID')
  const bytes = [profile, ...files].reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
  if (bytes > maxBytes) throw new NetworkError('VPN_PROFILE_TOO_LARGE')
  const assets = new Map<string, string>()
  for (const file of files) {
    const key = filename(file.name)
    if (!key || assets.has(key) || file.content.includes('\0')) throw new NetworkError('VPN_IMPORT_DUPLICATE_FILE')
    assets.set(key, file.content)
  }
  const output: string[] = []
  let block: string | undefined
  for (const line of profile.content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (block !== undefined) {
      output.push(line)
      if (trimmed === `</${block}>`) block = undefined
      continue
    }
    const opening = /^<([a-z0-9-]+)>$/u.exec(trimmed)
    if (opening) { block = opening[1]; output.push(line); continue }
    const parts = tokens(line)
    const option = parts[0]?.replace(/^--/u, '')
    if (option === undefined) { output.push(line); continue }
    if (executableOptions.has(option) || option === 'pkcs12') throw new NetworkError('VPN_PROFILE_UNSUPPORTED_OPTION')
    if (option === 'auth-user-pass') { output.push('auth-user-pass'); continue }
    if (!fileOptions.has(option) || parts[1] === '[inline]') { output.push(line); continue }
    const reference = parts[1]
    if (!reference) throw new NetworkError('VPN_PROFILE_SYNTAX')
    const content = assets.get(filename(reference))
    if (content === undefined) throw new NetworkError('VPN_PROFILE_REFERENCE_MISSING')
    if (/<\/?[a-z0-9-]+>/iu.test(content)) throw new NetworkError('VPN_PROFILE_INVALID_CERTIFICATE')
    output.push(`<${option}>`, content.trim(), `</${option}>`)
    if (option === 'tls-auth' && parts[2] !== undefined) {
      if (parts.length !== 3 || (parts[2] !== '0' && parts[2] !== '1')) throw new NetworkError('VPN_PROFILE_SYNTAX')
      output.push(`key-direction ${parts[2]}`)
    } else if (parts.length !== 2) throw new NetworkError('VPN_PROFILE_SYNTAX')
  }
  if (block !== undefined) throw new NetworkError('VPN_PROFILE_SYNTAX')
  const content = `${output.join('\n').trim()}\n`
  if (Buffer.byteLength(content) > maxBytes) throw new NetworkError('VPN_PROFILE_TOO_LARGE')
  return content
}
