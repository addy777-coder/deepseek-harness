import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { verifyDesktopRuntimeLock } from './desktop-runtime-lock.ts'

const resolution = { integrity: 'sha512-reviewed-content', tarball: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz' }
const source = dump({ packages: { 'example@1.0.0': { resolution } } })

describe('verified desktop runtime registry resolutions', () => {
  it('accepts the same registry records alongside pnpm-converted workspace directories', () => {
    const deployed = dump({ packages: { 'example@1.0.0': { resolution },
      'local@file:///workspace/local': { resolution: { type: 'directory', directory: '../../local' } } } })
    expect(() =>{  verifyDesktopRuntimeLock(source, deployed) }).not.toThrow()
  })

  it.each([
    ['integrity', { ...resolution, integrity: 'sha512-different-content' }],
    ['tarball URL', { ...resolution, tarball: 'https://unreviewed.invalid/example.tgz' }],
    ['unknown resolution', { type: 'git', repo: 'https://unreviewed.invalid/repo' }],
  ])('rejects changed %s before the runtime can be packaged', (_name, changed) => {
    expect(() =>{  verifyDesktopRuntimeLock(source, dump({ packages: { 'example@1.0.0': { resolution: changed } } })) }).toThrow()
  })

  it.each([{}, { 'example@2.0.0': { resolution } }, { 'example@1.0.0': { resolution }, 'extra@1.0.0': { resolution } }])(
    'rejects missing, replaced or additional registry identities', (packages) => {
      expect(() =>{  verifyDesktopRuntimeLock(source, dump({ packages })) }).toThrow()
    },
  )
})
