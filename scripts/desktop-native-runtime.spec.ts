import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const smoke = fileURLToPath(new URL('../apps/desktop/tests/native-runtime.smoke.cjs', import.meta.url))

function inspectTarget(expected: string | undefined) {
  return spawnSync(process.execPath, [smoke], {
    env: { SystemRoot: process.env.SystemRoot, EXPECTED_NATIVE: expected },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
}

describe('Desktop native runtime target verification', () => {
  it.each([
    `${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`,
    `${process.platform === 'darwin' ? 'linux' : 'darwin'}-${process.arch}`,
  ])('rejects a runtime outside the required %s target before loading addons', (expected) => {
    const result = inspectTarget(expected)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`expected ${expected}, received ${process.platform}-${process.arch}`)
    expect(result.stderr).not.toContain('DSH_DESKTOP_RUNTIME_DIR is required')
  })

  it.each([undefined, `${process.platform}-${process.arch}`])('continues to runtime verification with expected target %s', (expected) => {
    const result = inspectTarget(expected)
    expect(result.error).toBeUndefined()
    expect(result.stderr).toContain('DSH_DESKTOP_RUNTIME_DIR is required')
    expect(result.stderr).not.toContain('target mismatch')
  })
})
