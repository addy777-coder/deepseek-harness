/** Test-only Cordis application action for an explicitly requested live VPN acceptance run. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-subprocess'
import { runLiveAcceptance, type LiveAcceptanceOptions, type LiveAcceptanceReport } from './live-acceptance.ts'

/** Fixture plugin identity. */
export const name = 'vpn-live-acceptance'
/** Production services whose saved configuration the run consumes. */
export const inject = ['network', 'llm', 'settings', 'credentials', 'subprocess']

/** Live-run limits and report location; all authentication comes from saved services. */
export interface Config extends Omit<LiveAcceptanceOptions, 'signal'> {
  /** Maximum time to wait for the production helper to connect. */
  connectionTimeoutMs: number
  /** Maximum time for one read-only system network snapshot. */
  snapshotTimeoutMs: number
  /** Grace period for snapshot subprocess teardown. */
  shutdownGraceMs: number
  /** New JSON report file; an existing file is never overwritten. */
  reportPath: string
}

/** Validate non-secret fixture configuration before startup. */
export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().required(), model: Schema.string().required(),
  requestTimeoutMs: Schema.number().min(1000).max(1800000).step(1).required(),
  maxTokens: Schema.number().min(1024).max(131072).step(1).required(),
  minimumLongResponseChars: Schema.number().min(1024).max(1048576).step(1).required(),
  checkDiscovery: Schema.boolean().required(),
  connectionTimeoutMs: Schema.number().min(1000).max(600000).step(1).required(),
  snapshotTimeoutMs: Schema.number().min(1000).max(120000).step(1).required(),
  shutdownGraceMs: Schema.number().min(100).max(60000).step(1).required(),
  reportPath: Schema.string().required(),
})

interface NetworkSnapshot { digest: string; externalOpenvpnActive: boolean; helperCount: number }
interface Report {
  formatVersion: 1
  startedAt: string
  finishedAt: string
  passed: boolean
  failureCode: string | null
  networkUnchanged: boolean | null
  externalOpenvpnAbsent: boolean | null
  ownedHelperExited: boolean | null
  checks?: LiveAcceptanceReport
}

const snapshotScript = fileURLToPath(new URL('./network-snapshot.ps1', import.meta.url))

async function snapshot(ctx: Context, config: Config, signal: AbortSignal): Promise<NetworkSnapshot> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.snapshotTimeoutMs)])
  deadline.throwIfAborted()
  const child = ctx.subprocess.spawn({ argv: ['pwsh', '-NoProfile', '-NonInteractive', '-File', snapshotScript, '-AsJson'],
    cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: config.shutdownGraceMs })
  const abort = (): void => { child.terminate() }
  deadline.addEventListener('abort', abort, { once: true })
  let bytes = 0
  const chunks: Buffer[] = []
  let stderr = false
  child.stderr!.on('data', () => { stderr = true })
  child.stderr!.on('error', () => { stderr = true })
  try {
    for await (const value of child.stdout!) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
      bytes += chunk.length
      if (bytes > 1048576) throw new Error('VPN_LIVE_SNAPSHOT_TOO_LARGE')
      chunks.push(chunk)
    }
    const outcome = await child.done
    if (deadline.aborted || stderr || outcome.exitCode !== 0) throw new Error('VPN_LIVE_NETWORK_SNAPSHOT_FAILED')
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || !('network' in parsed) || typeof parsed.network !== 'string'
      || !('externalOpenvpnActive' in parsed) || typeof parsed.externalOpenvpnActive !== 'boolean'
      || !('helperCount' in parsed) || typeof parsed.helperCount !== 'number' || !Number.isSafeInteger(parsed.helperCount)) {
      throw new Error('VPN_LIVE_NETWORK_SNAPSHOT_INVALID')
    }
    return { digest: createHash('sha256').update(parsed.network).digest('hex'),
      externalOpenvpnActive: parsed.externalOpenvpnActive, helperCount: parsed.helperCount }
  } finally {
    deadline.removeEventListener('abort', abort)
    child.terminate()
    await child.done
  }
}

async function connect(ctx: Context, config: Config, signal: AbortSignal): Promise<void> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.connectionTimeoutMs)])
  deadline.throwIfAborted()
  let aborted = (): void => {}
  const cancelled = new Promise<never>((_, reject) => {
    aborted = (): void => { reject(new Error('VPN_LIVE_CONNECTION_DEADLINE')) }
    deadline.addEventListener('abort', aborted, { once: true })
  })
  try {
    await Promise.race([ctx.network.connect(), cancelled])
    if ((await ctx.network.get()).connection !== 'connected') throw new Error('VPN_LIVE_CONNECTION_FAILED')
  } finally { deadline.removeEventListener('abort', aborted) }
}

function failureCode(error: unknown): string {
  return error instanceof Error && /^VPN_[A-Z0-9_]{1,100}$/u.test(error.message) ? error.message : 'VPN_LIVE_FAILED'
}

async function execute(ctx: Context, config: Config, signal: AbortSignal): Promise<Report> {
  const report: Report = { formatVersion: 1, startedAt: new Date().toISOString(), finishedAt: '', passed: false,
    failureCode: null, networkUnchanged: null, externalOpenvpnAbsent: null, ownedHelperExited: null }
  let before: NetworkSnapshot | undefined
  let during: NetworkSnapshot | undefined
  try {
    if (!(await ctx.llm.listModels(config.provider)).some(model => model.id === config.model)) {
      throw new Error('VPN_LIVE_SAVED_MODEL_MISSING')
    }
    before = await snapshot(ctx, config, signal)
    report.externalOpenvpnAbsent = !before.externalOpenvpnActive
    if (before.externalOpenvpnActive || before.helperCount > 1) throw new Error('VPN_LIVE_COMPETING_VPN')
    await connect(ctx, config, signal)
    during = await snapshot(ctx, config, signal)
    if (during.externalOpenvpnActive || during.helperCount !== 1) throw new Error('VPN_LIVE_COMPETING_VPN')
    if (during.digest !== before.digest) throw new Error('VPN_LIVE_SYSTEM_NETWORK_CHANGED')
    report.checks = await runLiveAcceptance(ctx, { ...config, signal })
    report.passed = true
  } catch (error) {
    report.failureCode = failureCode(error)
  } finally {
    try {
      await ctx.network.disconnect()
      // Cleanup verification gets its own bounded deadline even when the model run was cancelled.
      const after = await snapshot(ctx, config, AbortSignal.timeout(config.snapshotTimeoutMs))
      report.ownedHelperExited = after.helperCount === 0
      if (before) report.networkUnchanged = before.digest === after.digest && (!during || before.digest === during.digest)
      report.externalOpenvpnAbsent = (report.externalOpenvpnAbsent ?? true) && !after.externalOpenvpnActive
      if (!report.ownedHelperExited || report.networkUnchanged === false || !report.externalOpenvpnAbsent) {
        report.passed = false
        report.failureCode ??= 'VPN_LIVE_CLEANUP_VERIFICATION_FAILED'
      }
    } catch {
      report.passed = false
      report.failureCode ??= 'VPN_LIVE_CLEANUP_FAILED'
    }
    report.finishedAt = new Date().toISOString()
  }
  return report
}

/**
 * Run the acceptance action only after the supported dsh launcher commits startup.
 * @param ctx - production services and launcher-owned readiness/exit values.
 * @param config - validated saved model selection, budgets and new report path.
 */
export function apply(ctx: Context, config: Config): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('VPN live acceptance requires the dsh profile launcher')
  const abort = new AbortController()
  let active = true
  let running: Promise<void> | undefined
  ctx.effect(() => ready.onReady(() => {
    if (!active) return
    running = execute(ctx, config, abort.signal).then(async report => {
      const reportPath = resolve(config.reportPath)
      try {
        await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 })
        await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        process.stdout.write(JSON.stringify({ event: 'vpn-live-acceptance', passed: report.passed, reportPath,
          failureCode: report.failureCode }) + '\n')
      } catch {
        report.passed = false
        process.stderr.write('VPN_LIVE_REPORT_WRITE_FAILED\n')
      }
      if (active) exit(report.passed ? 0 : 1)
    })
  }))
  ctx.effect(() => async () => { active = false; abort.abort(); await running })
}
