/** Stage the real installed dsh closure consumed by the packaged Desktop Host. */
import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { verifyDesktopRuntimeLock } from './desktop-runtime-lock.ts'
import { prepareDesktopRuntimeAssets } from './desktop-runtime-assets.ts'
import { resolveVpnTarget } from '../apps/desktop/src/main/vpn-artifact.ts'

const root = resolve(import.meta.dirname, '..')
const deployRoot = resolve(root, 'apps/desktop/runtime-closure')
const staging = resolve(root, '.dsh-build/desktop-runtime')
const workspaceStatePath = resolve(root, 'node_modules/.pnpm-workspace-state-v1.json')
const workspaceConfigPath = resolve(root, 'pnpm-workspace.yaml')
const workspaceLockPath = resolve(root, 'pnpm-lock.yaml')
const target = resolveVpnTarget()

function assertStagingPath(): void {
  const rel = relative(root, staging)
  if (rel !== `.dsh-build${sep}desktop-runtime`) {
    throw new Error(`stage-desktop-runtime: refusing unexpected staging path ${staging}`)
  }
}

async function run(label: string, command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, CI: 'true' }, stdio: 'inherit' })
    child.once('error', (error) => {
      reject(new Error(`stage-desktop-runtime: ${label} failed to spawn: ${error.message}`, { cause: error }))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`stage-desktop-runtime: ${label} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`})`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function restoreFile(path: string, content: Buffer | undefined): Promise<void> {
  if (content === undefined) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, content)
}

async function restoreDirectDependencies(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const destination = join(staging, 'node_modules', dependency)
    if (await exists(destination)) continue
    const source = join(deployRoot, 'node_modules', dependency)
    if (!await exists(source)) {
      throw new Error(`stage-desktop-runtime: deployed dependency is missing: ${dependency}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const sourceRoot = await realpath(source)
    const nestedNodeModules = join(sourceRoot, 'node_modules')
    await cp(sourceRoot, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
  }
}

async function firstSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await firstSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let link = await firstSymlink(nodeModules)
  while (link !== undefined) {
    const target = await realpath(link)
    const nestedNodeModules = join(target, 'node_modules')
    await unlink(link)
    await cp(target, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
    link = await firstSymlink(nodeModules)
  }
}

assertStagingPath()
await rm(staging, { recursive: true, force: true })
const verifiedLock = await readFile(workspaceLockPath, 'utf8')
const verification = pnpmInvocation(['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--config.trust-lockfile=false'])
await run('verify workspace lock', verification.command, verification.args)
if (await readFile(workspaceLockPath, 'utf8') !== verifiedLock) throw new Error('stage-desktop-runtime: workspace lock changed during verification')
const workspaceState = await readOptional(workspaceStatePath)
const workspaceConfig = await readOptional(workspaceConfigPath)
const invocation = pnpmInvocation([
  '--filter', 'dsh-desktop-runtime-closure',
  'deploy', '--prod', '--offline', '--trust-lockfile', '--ignore-scripts',
  '--config.inject-workspace-packages=true',
  '--config.node-linker=hoisted',
  '--config.link-workspace-packages=true',
  staging,
])
let stageError: unknown
try {
  await run('deploy', invocation.command, invocation.args)
  if (await readFile(workspaceLockPath, 'utf8') !== verifiedLock) throw new Error('stage-desktop-runtime: workspace lock changed during deploy')
  verifyDesktopRuntimeLock(verifiedLock, await readFile(join(staging, 'pnpm-lock.yaml'), 'utf8'))
  await restoreDirectDependencies()
  await materializeLinks()
  await prepareDesktopRuntimeAssets(staging, target)
  if (await readFile(workspaceLockPath, 'utf8') !== verifiedLock) throw new Error('stage-desktop-runtime: workspace lock changed during staging')
} catch (error) {
  stageError = error
}
try {
  // Deploy can record its production/hoisted options in the source workspace.
  // Restore its generated state and release-age edits so staging leaves the
  // source workspace byte-identical.
  await restoreFile(workspaceStatePath, workspaceState)
  await restoreFile(workspaceConfigPath, workspaceConfig)
} catch (error) {
  if (stageError !== undefined) {
    throw new AggregateError([stageError, error], 'stage-desktop-runtime: staging and workspace restoration failed')
  }
  throw error
}
if (stageError !== undefined) {
  throw stageError instanceof Error
    ? stageError
    : new Error('stage-desktop-runtime: staging failed with a non-Error reason', { cause: stageError })
}
console.log(`stage-desktop-runtime: staged ${staging}`)
