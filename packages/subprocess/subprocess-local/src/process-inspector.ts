/** Platform process-table inspection for terminal readiness, signals, and teardown. */

import { createPosixProcessInspector, type ProcessInspector, type ProcessInspectorInternals } from './posix-process-inspector.ts'
import { createWindowsProcessInspector } from './windows-inspector.ts'

export { linuxProcessGroupHasLiveMembers, parseProcStat } from './posix-process-inspector.ts'
export type { ProcessIdentity, ProcessInspector, ProcessInspectorInternals, ProcessSnapshot } from './posix-process-inspector.ts'

/**
 * Create the supported platform inspector or fail at plugin load.
 * @param platform - target Node platform.
 * @param arch - target CPU architecture for Linux syscall numbers.
 * @param internals - POSIX filesystem/process operations, injectable for deterministic tests.
 * @returns Platform process inspector.
 */
export function createProcessInspector(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  internals?: ProcessInspectorInternals,
): ProcessInspector {
  return platform === 'win32'
    ? createWindowsProcessInspector()
    : createPosixProcessInspector(platform, arch, internals)
}
