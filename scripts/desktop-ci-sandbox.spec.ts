/** Exact AppArmor attachment paths for the Linux Desktop CI GUI. */
import { describe, expect, it } from 'vitest'
import { desktopCiSandboxProfile } from './desktop-ci-sandbox.ts'

const executable = '/home/runner/work/deepseek-harness/deepseek-harness/apps/desktop/dist-electron/linux-unpacked/dsh-desktop'

describe('Desktop CI AppArmor profile', () => {
  it('permits user namespaces only for the packaged executable attachment', () => {
    expect(desktopCiSandboxProfile(executable, 'dsh-desktop-ci-123-2')).toBe(
      `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile "dsh-desktop-ci-123-2" "${executable}" flags=(unconfined) {\n  userns,\n}\n`,
    )
  })

  it.each([
    executable.replace('runner', '*'),
    executable.replace('runner', 'runner?'),
    executable.replace('runner', '{runner,root}'),
    executable.replace('runner', 'runner"'),
    executable.replace('/work/', '/work/../'),
    executable.replace('/linux-unpacked/dsh-desktop', '/linux-unpacked/another-app'),
    `relative${executable}`,
  ])('rejects broadened or unexpected attachment paths: %s', (path) => {
    expect(() => desktopCiSandboxProfile(path, 'dsh-desktop-ci-123-2')).toThrow('exact Linux unpacked application path')
  })

  it.each(['dsh-desktop', 'dsh-desktop-ci-123-*', 'dsh-desktop-ci-123-2"'])('rejects non-private profile names: %s', (name) => {
    expect(() => desktopCiSandboxProfile(executable, name)).toThrow('run-specific name')
  })
})
