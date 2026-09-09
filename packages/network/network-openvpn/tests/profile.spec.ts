/** Bounded, self-contained profile imports without Host file access. */
import { describe, expect, it } from 'vitest'
import { importProfile } from '../src/profile.ts'

const certificate = '-----BEGIN CERTIFICATE-----\npublic-data\n-----END CERTIFICATE-----'
const key = '-----BEGIN OpenVPN Static key V1-----\nkey-data\n-----END OpenVPN Static key V1-----'
const file = (content: string) => ({ name: 'client.ovpn', content })

describe('OpenVPN profile import', () => {
  it('inlines selected Windows references and retains TLS key direction', () => {
    const profile = '\uFEFFclient\r\nremote vpn.example 1194\r\nca "C:\\vpn\\Company CA.pem" # certificate\r\ntls-auth keys/static.key 1\r\nauth-user-pass credentials.txt\r\n'
    expect(importProfile(file(profile), [
      { name: 'company ca.PEM', content: certificate },
      { name: 'static.key', content: key },
    ], 4096)).toBe(`client\nremote vpn.example 1194\n<ca>\n${certificate}\n</ca>\n<tls-auth>\n${key}\n</tls-auth>\nkey-direction 1\nauth-user-pass\n`)
  })

  it('preserves inline certificates and non-executable directives', () => {
    const profile = `client\n# retained comment\n<ca>\n${certificate}\n</ca>\n<connection>\nremote vpn.example 443 tcp\n</connection>\n`
    expect(importProfile(file(profile), [], 4096)).toBe(profile)
  })

  it('recognizes quoted and --prefixed references without treating comment text as directives', () => {
    expect(importProfile(file("; plugin ignored.dll\n--ca 'root cert.pem'\n"), [
      { name: 'root cert.pem', content: certificate },
    ], 4096)).toBe(`; plugin ignored.dll\n<ca>\n${certificate}\n</ca>\n`)
  })

  it('decodes escaped slashes and quotes inside a quoted reference', () => {
    const profile = String.raw`   ca "folder\\root.pem"
cert "my \"quoted\".pem"`
    expect(importProfile(file(profile), [
      { name: 'root.pem', content: certificate }, { name: 'my "quoted".pem', content: certificate },
    ], 4096)).toBe(`<ca>\n${certificate}\n</ca>\n<cert>\n${certificate}\n</cert>\n`)
  })

  it.each(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs'])(
    'inlines a %s reference from the selected files', (option) => {
      expect(importProfile(file(`${option} shared.pem`), [{ name: 'shared.pem', content: certificate }], 4096))
        .toBe(`<${option}>\n${certificate}\n</${option}>\n`)
    },
  )

  it.each(['config', 'plugin', 'up', 'down', 'route-up', 'ipchange', 'management', 'management-client', 'tls-verify', 'pkcs12'])(
    'rejects %s instead of accessing a file or launching a hook', (option) => {
      expect(() => importProfile(file(`${option} outside-resource`), [], 4096))
        .toThrow('VPN_PROFILE_UNSUPPORTED_OPTION')
    },
  )

  it('refuses missing references without trying to read their Host paths', () => {
    expect(() => importProfile(file('ca C:\\Users\\private\\root.pem'), [], 4096))
      .toThrow('VPN_PROFILE_REFERENCE_MISSING')
  })

  it.each([
    'ca "unterminated',
    '<ca>\nmissing closing tag',
    'ca',
    'tls-auth static.key 2',
    'tls-auth static.key 1 extra',
    'cert static.key extra',
  ])('rejects malformed profile syntax: %s', (content) => {
    expect(() => importProfile(file(content), [{ name: 'static.key', content: key }], 4096))
      .toThrow('VPN_PROFILE_SYNTAX')
  })

  it('rejects ambiguous filenames and certificate content that injects profile directives', () => {
    expect(() => importProfile(file('client'), [
      { name: 'a/ROOT.pem', content: certificate }, { name: 'b/root.pem', content: certificate },
    ], 4096)).toThrow('VPN_IMPORT_DUPLICATE_FILE')
    expect(() => importProfile(file('ca root.pem'), [
      { name: 'root.pem', content: '</ca>\nremote attacker.example\n<ca>' },
    ], 4096)).toThrow('VPN_PROFILE_INVALID_CERTIFICATE')
  })

  it('rejects NULs and empty selected filenames', () => {
    expect(() => importProfile(file('client\0'), [], 4096)).toThrow('VPN_PROFILE_INVALID')
    expect(() => importProfile(file('client'), [{ name: 'ca.pem', content: 'x\0' }], 4096))
      .toThrow('VPN_IMPORT_DUPLICATE_FILE')
    expect(() => importProfile(file('client'), [{ name: '', content: certificate }], 4096))
      .toThrow('VPN_IMPORT_DUPLICATE_FILE')
  })

  it('bounds aggregate UTF-8 input, selected-file count, and repeated expansion', () => {
    expect(() => importProfile(file('中'.repeat(8)), [], 16)).toThrow('VPN_PROFILE_TOO_LARGE')
    expect(() => importProfile(file('client'), Array.from({ length: 17 }, (_, index) => ({
      name: `${index}.pem`, content: '',
    })), 4096)).toThrow('VPN_PROFILE_INVALID')
    expect(() => importProfile(file('ca root.pem\ncert root.pem'), [{ name: 'root.pem', content: 'x'.repeat(60) }], 100))
      .toThrow('VPN_PROFILE_TOO_LARGE')
  })
})
