/** Grant one CI Desktop executable AppArmor user-namespace access for Chromium. */
import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { isEntry } from './release/process.ts'

/**
 * Create an AppArmor profile that attaches only to the CI application's absolute executable path.
 * @param executable - absolute Linux application path without AppArmor pattern characters.
 * @param name - run-specific profile name used for installation and removal.
 * @returns an unconfined profile granting user namespaces while Chromium keeps its own sandbox.
 */
export function desktopCiSandboxProfile(executable: string, name: string): string {
  if (!/^\/[A-Za-z0-9_./ -]+$/u.test(executable) || posix.resolve(executable) !== executable
    || !executable.endsWith('/apps/desktop/dist-electron/linux-unpacked/dsh-desktop')) {
    throw new Error('Desktop CI AppArmor executable must be the exact Linux unpacked application path')
  }
  if (!/^dsh-desktop-ci-[0-9]+-[0-9]+$/u.test(name)) throw new Error('Desktop CI AppArmor profile requires a run-specific name')
  return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile "${name}" "${executable}" flags=(unconfined) {\n  userns,\n}\n`
}

async function main(): Promise<void> {
  const action = process.argv[2]
  if (process.platform !== 'linux' || process.argv.length !== 3 || (action !== 'prepare' && action !== 'cleanup')) {
    throw new Error('usage on Linux: desktop-ci-sandbox.ts <prepare|cleanup>')
  }
  const { RUNNER_TEMP: temporary, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, DSH_DESKTOP_EXECUTABLE: executable } = process.env
  if (temporary === undefined || runId === undefined || attempt === undefined || executable === undefined) {
    throw new Error('Desktop CI sandbox requires runner paths and run identity')
  }
  const name = `dsh-desktop-ci-${runId}-${attempt}`
  const content = desktopCiSandboxProfile(executable, name)
  const file = join(temporary, `${name}.apparmor`)
  if (action === 'cleanup') {
    try {
      await readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    execFileSync('sudo', ['apparmor_parser', '--remove', file], { stdio: 'inherit' })
    await rm(file)
    return
  }
  let enabled: string
  try {
    enabled = await readFile('/sys/module/apparmor/parameters/enabled', 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (enabled.trim() !== 'Y') return
  await writeFile(file, content, { mode: 0o600 })
  execFileSync('sudo', ['apparmor_parser', '--replace', file], { stdio: 'inherit' })
}

if (isEntry(import.meta.url)) await main()
