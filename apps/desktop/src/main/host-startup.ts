/** Readiness budget and diagnostics for the Desktop Host process. */
import type { DesktopHostStartupPhase } from '@deepseek-ai/dsh-desktop-transport'

/** Cold-start budget for profile reconciliation and Loader settlement. */
export const HOST_START_TIMEOUT_MS = 120_000

const PHASE_LABELS: Record<DesktopHostStartupPhase, string> = {
  bootstrap: 'Host bootstrap',
  profile: 'profile initialization',
  loader: 'Loader settlement',
}

/** State sampled only if the Host misses its readiness deadline. */
export interface HostStartupDiagnostic {
  /** Most recent startup phase reported by the Utility Process. */
  phase: DesktopHostStartupPhase
  /** Bounded Host stderr chunks captured by the main process. */
  stderrTail: readonly string[]
}

/**
 * Format a readiness timeout with the last reported startup phase and Host stderr.
 * @param timeoutMs - complete readiness budget in milliseconds.
 * @param diagnostic - latest phase and bounded stderr tail.
 * @returns user-visible diagnostic text.
 */
export function hostReadinessTimeoutMessage(
  timeoutMs: number,
  diagnostic: HostStartupDiagnostic,
): string {
  const stderr = diagnostic.stderrTail.join('').trim()
  const message = `desktop host: readiness timed out after ${String(timeoutMs / 1_000)} seconds during ${PHASE_LABELS[diagnostic.phase]}`
  return stderr === '' ? message : `${message}\nHost stderr:\n${stderr}`
}

/**
 * Await Host readiness within the cold-start budget and clear the deadline timer on every outcome.
 * @param ready - Utility Process readiness promise.
 * @param diagnostic - current startup diagnostic sampled at the deadline.
 * @param timeoutMs - deadline budget; defaults to the installed cold-start budget.
 * @returns settlement after the Host reports ready.
 */
export async function waitForHostReadiness(
  ready: Promise<void>,
  diagnostic: () => HostStartupDiagnostic,
  timeoutMs = HOST_START_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(hostReadinessTimeoutMessage(timeoutMs, diagnostic())))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
