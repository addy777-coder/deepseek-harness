/** Transactional package management for the Desktop profile. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import { parse as parseYaml } from 'yaml'
import { reconcileProfileBundles, type ProfileManifest } from '@deepseek-ai/dsh-app-boot/profile-plugins'
import type {
  DesktopPluginInfo, DesktopPluginRequest, DesktopPluginStage,
} from '../shared/contracts.ts'

const SCRIPT_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'] as const
const COMMAND_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024

const pluginCopy = {
  en: {
    apply: 'Apply and restart',
    cancel: 'Cancel',
    title: 'DSH Desktop plugins',
    warning: 'Plugins execute with the same local permissions as the DSH Host.',
    detail: (action: DesktopPluginRequest['action']) => `Apply ${action} and restart the Host?`,
  },
  zh: {
    apply: '应用并重启',
    cancel: '取消',
    title: 'DSH Desktop 插件',
    warning: '插件会以 DSH Host 相同的本机权限执行。',
    detail: (action: DesktopPluginRequest['action']) => `应用 ${action} 并重启 Host？`,
  },
} as const

function labels(): typeof pluginCopy.en | typeof pluginCopy.zh {
  return app.getLocale().toLowerCase().startsWith('zh') ? pluginCopy.zh : pluginCopy.en
}

interface PackageManifest {
  name?: string
  version?: string
  scripts?: Record<string, unknown>
  exports?: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: unknown }
}

interface ClientValidation {
  readonly status: DesktopPluginInfo['clientBundle']
  readonly error?: Error
}

interface PnpmLockfile {
  importers?: Record<string, {
    dependencies?: Record<string, string | { version?: string }>
  }>
  packages?: Record<string, {
    resolution?: { integrity?: string; commit?: string; tarball?: string }
  }>
}

interface StagedTransaction {
  readonly token: string
  readonly root: string
  readonly profile: string
  readonly baseline: string
  readonly summary: DesktopPluginStage
}

interface ApplyHooks {
  stopHost(): Promise<void>
  startHost(): Promise<void>
  reloadWindows(): void
  parentWindow(): BrowserWindow | undefined
}

interface PluginManagerRuntime {
  home(): string
  runPackageManager(cwd: string, args: readonly string[]): Promise<string>
  confirm(parent: BrowserWindow | undefined, options: MessageBoxOptions): Promise<boolean>
}

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(app.getPath('home'), '.dsh'))
}

function profileDir(home: string): string {
  return join(home, 'profiles', 'desktop')
}

function stagingRoot(home: string): string {
  return join(home, '.desktop-plugin-staging')
}

function pnpmBin(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.mjs')
    : join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
}

function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return
  throw new Error(`desktop plugins: path escaped managed root: ${target}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function hashPart(hash: ReturnType<typeof createHash>, kind: string, path: string, content: Uint8Array): void {
  hash.update(`${kind.length}:${kind}${path.length}:${path}${String(content.byteLength)}:`)
  hash.update(content)
}

/** Hash profile-owned files while excluding the package-manager materialization. */
async function profileFingerprint(profile: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => prefix !== '' || entry.name !== 'node_modules')
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        hashPart(hash, 'link', relativePath, Buffer.from(await readlink(path)))
      } else if (metadata.isDirectory()) {
        hashPart(hash, 'directory', relativePath, Buffer.alloc(0))
        await visit(path, relativePath)
      } else if (metadata.isFile()) {
        hashPart(hash, 'file', relativePath, await readFile(path))
      }
    }
  }
  await visit(profile, '')
  return hash.digest('hex')
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk
  const bytes = Buffer.from(next)
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return next
  return bytes.subarray(bytes.byteLength - MAX_OUTPUT_BYTES).toString('utf8').replace(/^\uFFFD/u, '')
}

function scrubbedPackageManagerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())))
}

function redactPackageManagerOutput(value: string): string {
  return value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/gu, '$1***@')
    .replace(/([?&](?:access_?token|api_?key|key|password|secret|token)=)[^\s&#]+/giu, '$1***')
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || process.platform !== 'win32') {
    child.kill()
    return
  }
  await new Promise<void>((resolvePromise) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => { child.kill(); resolvePromise() })
    killer.once('exit', (code) => { if (code !== 0) child.kill(); resolvePromise() })
  })
}

async function runPnpm(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let output = ''
    let timedOut = false
    const child = spawn(process.execPath, [pnpmBin(), ...args], {
      cwd,
      windowsHide: true,
      env: { ...scrubbedPackageManagerEnv(), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      void terminateProcessTree(child)
    }, COMMAND_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { output = appendBounded(output, String(chunk)) })
    child.stderr.on('data', (chunk) => { output = appendBounded(output, String(chunk)) })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`desktop plugins: pnpm timed out\n${redactPackageManagerOutput(output.trim())}`))
      } else if (code !== 0) {
        reject(new Error(`desktop plugins: pnpm failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`})\n${redactPackageManagerOutput(output.trim())}`))
      } else {
        resolvePromise(output)
      }
    })
  })
}

const DEFAULT_RUNTIME: PluginManagerRuntime = {
  home: dshHome,
  runPackageManager: runPnpm,
  confirm: async (parent, options) => {
    const result = parent === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options)
    return result.response === 0
  },
}

function validateSpec(spec: unknown): string {
  if (typeof spec !== 'string') throw new TypeError('desktop plugins: package spec must be a string')
  const value = spec.trim()
  if (value === '' || value.length > 2048 || value.startsWith('-') || /[\0\r\n]/u.test(value)) {
    throw new TypeError('desktop plugins: package spec must be one non-option argument')
  }
  if (value.startsWith('.') || value.startsWith('file:.') || value.startsWith('link:.')) {
    throw new TypeError('desktop plugins: local package specs must use an absolute path')
  }
  return value
}

function validatePackageName(name: unknown): string {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name)) {
    throw new TypeError('desktop plugins: invalid package name')
  }
  return name
}

/** Parse one exact plugin-management request received across Electron IPC. */
export function parseDesktopPluginRequest(value: unknown): DesktopPluginRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('desktop plugins: invalid request')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (record.action === 'install' && keys.length === 2 && Object.hasOwn(record, 'spec')) {
    return { action: 'install', spec: validateSpec(record.spec) }
  }
  if ((record.action === 'update' || record.action === 'remove')
    && keys.length === 2 && Object.hasOwn(record, 'name')) {
    return { action: record.action, name: validatePackageName(record.name) }
  }
  throw new TypeError('desktop plugins: invalid request')
}

async function directPackage(profile: string, name: string): Promise<{ manifest: PackageManifest; path: string }> {
  const path = join(profile, 'node_modules', ...name.split('/'), 'package.json')
  const canonical = await realpath(path)
  return { manifest: await readJson<PackageManifest>(canonical), path: canonical }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function bundleLoaderNames(source: string, name: string): string[] {
  const parsed = parseYaml(source, { logLevel: 'silent' }) as unknown
  if (!Array.isArray(parsed)) throw new Error(`desktop plugins: ${name} bundle patch root must be an array`)
  const names = new Set<string>()
  const visitEntry = (value: unknown, label: string): void => {
    const entry = record(value)
    if (entry === undefined) throw new Error(`desktop plugins: ${name} ${label} must be an object`)
    if ('name' in entry) {
      if (typeof entry.name !== 'string') {
        throw new Error(`desktop plugins: ${name} ${label}.name must be a string`)
      }
      names.add(entry.name)
    }
    if (entry.group === true) {
      if (!Array.isArray(entry.config)) {
        throw new Error(`desktop plugins: ${name} ${label}.config must be an array for a group row`)
      }
      entry.config.forEach((child, index) => { visitEntry(child, `${label}.config[${String(index)}]`) })
    }
  }
  parsed.forEach((value, patchIndex) => {
    const patch = record(value)
    if (patch === undefined) {
      throw new Error(`desktop plugins: ${name} bundle patch[${String(patchIndex)}] must be an object`)
    }
    if (patch.insert === undefined) return
    if (!Array.isArray(patch.insert)) {
      throw new Error(`desktop plugins: ${name} bundle patch[${String(patchIndex)}].insert must be an array`)
    }
    patch.insert.forEach((entry, entryIndex) => {
      visitEntry(entry, `bundle patch[${String(patchIndex)}].insert[${String(entryIndex)}]`)
    })
  })
  return [...names]
}

function rootPackageName(specifier: string): string | undefined {
  return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(specifier) ? specifier : undefined
}

async function nearestPackageManifest(path: string, expectedName: string): Promise<string | undefined> {
  let directory = dirname(path)
  for (;;) {
    const candidate = join(directory, 'package.json')
    try {
      const manifest = await readJson<PackageManifest>(candidate)
      if (manifest.name === expectedName) return await realpath(candidate)
    } catch {
      // The resolved entry may sit below directories without package metadata.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

async function resolveLoaderPackage(bundleManifest: string, specifier: string): Promise<string | undefined> {
  const packageName = rootPackageName(specifier)
  if (packageName === undefined) return undefined
  const require = createRequire(bundleManifest)
  try {
    return await realpath(require.resolve(`${packageName}/package.json`))
  } catch {
    for (const searchPath of require.resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, ...packageName.split('/'), 'package.json')
      if (await isFile(candidate)) return await realpath(candidate)
    }
    try {
      return await nearestPackageManifest(require.resolve(packageName), packageName)
    } catch {
      throw new Error(`desktop plugins: bundle row package ${packageName} is not installed`)
    }
  }
}

function stringArray(value: unknown, label: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
    throw new Error(`desktop plugins: ${label} must be a string array`)
  }
}

async function validateClientManifest(path: string): Promise<boolean> {
  const manifest = await readJson<PackageManifest>(path)
  if (manifest.dsh?.client === undefined) return false
  const name = manifest.name ?? dirname(path)
  const declaration = record(manifest.dsh.client)
  if (declaration === undefined || typeof declaration.platform !== 'string') {
    throw new Error(`desktop plugins: ${name} has an invalid dsh.client declaration`)
  }
  stringArray(declaration.inject, `${name} dsh.client.inject`)
  stringArray(declaration.external, `${name} dsh.client.external`)
  if (declaration.immediately !== undefined && typeof declaration.immediately !== 'boolean') {
    throw new Error(`desktop plugins: ${name} dsh.client.immediately must be a boolean`)
  }
  if (declaration.platform !== 'web') return false
  const client = clientExport(manifest)
  if (client === undefined) {
    throw new Error(`desktop plugins: ${name} declares dsh.client without a built ./client export`)
  }
  const packageRoot = dirname(path)
  const clientPath = resolve(packageRoot, client)
  assertInside(packageRoot, clientPath)
  if (!await isFile(clientPath)) {
    throw new Error(`desktop plugins: ${name} declares dsh.client without a built ./client export`)
  }
  await readFile(clientPath)
  return true
}

async function inspectBundleClients(installed: { manifest: PackageManifest; path: string }): Promise<ClientValidation> {
  try {
    const packageName = installed.manifest.name ?? dirname(installed.path)
    const patch = installed.manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') return { status: 'not-declared' }
    const packageRoot = dirname(installed.path)
    const patchPath = resolve(packageRoot, patch)
    assertInside(packageRoot, patchPath)
    const loaderNames = bundleLoaderNames(await readFile(patchPath, 'utf8'), packageName)
    const manifests = new Set<string>([installed.path])
    for (const loaderName of loaderNames) {
      const manifest = await resolveLoaderPackage(installed.path, loaderName)
      if (manifest !== undefined) manifests.add(manifest)
    }
    let declared = false
    for (const manifest of manifests) declared = await validateClientManifest(manifest) || declared
    return { status: declared ? 'verified' : 'not-declared' }
  } catch (error) {
    return { status: 'missing', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

async function resolvedReference(profile: string, name: string, spec: string): Promise<string> {
  try {
    const lock = parseYaml(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')) as PnpmLockfile
    const importer = lock.importers?.['.']?.dependencies?.[name]
    const version = typeof importer === 'string' ? importer : importer?.version
    if (version === undefined) return spec
    const plainVersion = version.replace(/\(.+$/u, '')
    const exact = lock.packages?.[`${name}@${plainVersion}`]
    const candidate = exact ?? Object.entries(lock.packages ?? {})
      .find(([key]) => key.startsWith(`${name}@`) && key.includes(plainVersion))?.[1]
    const resolution = candidate?.resolution
    if (resolution?.commit !== undefined) return `commit:${resolution.commit}`
    if (resolution?.integrity !== undefined) return `integrity:${resolution.integrity}`
    if (resolution?.tarball !== undefined) {
      try {
        const url = new URL(resolution.tarball)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return `tarball:${url.href}`
      } catch {
        return 'tarball'
      }
    }
    return redactPackageManagerOutput(version)
  } catch {
    return redactPackageManagerOutput(spec)
  }
}

async function listAt(profile: string): Promise<DesktopPluginInfo[]> {
  const manifest = await readJson<ProfileManifest>(join(profile, 'package.json'))
  const result: DesktopPluginInfo[] = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    const installed = await directPackage(profile, name)
    const clientBundle = (await inspectBundleClients(installed)).status
    result.push({
      name,
      spec: redactPackageManagerOutput(spec),
      version: installed.manifest.version ?? 'unknown',
      resolution: await resolvedReference(profile, name, spec),
      bundlePatch: installed.manifest.dsh?.bundle?.patch ?? null,
      clientBundle,
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

async function packageDirectories(nodeModules: string): Promise<string[]> {
  const result: string[] = []
  let entries
  try {
    entries = await readdir(nodeModules, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) result.push(join(path, child.name))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      result.push(path)
    }
  }
  return result
}

function packageLocationIdentity(profile: string, canonical: string): string {
  const rel = relative(profile, canonical)
  const marker = `${sep}.pnpm${sep}`
  const markerAt = rel.indexOf(marker)
  if (markerAt < 0) return rel.startsWith(`..${sep}`) ? canonical : rel
  const packageAt = markerAt + marker.length
  const packageEnd = rel.indexOf(`${sep}node_modules${sep}`, packageAt)
  return packageEnd < 0 ? rel : rel.slice(packageAt, packageEnd)
}

async function lifecycleScripts(profile: string): Promise<Map<string, string>> {
  const queue = await packageDirectories(join(profile, 'node_modules'))
  const visited = new Set<string>()
  const scripts = new Map<string, string>()
  while (queue.length > 0) {
    const directory = queue.pop()
    if (directory === undefined) break
    let canonical: string
    try {
      canonical = await realpath(directory)
    } catch {
      continue
    }
    if (visited.has(canonical)) continue
    visited.add(canonical)
    let manifest: PackageManifest
    let manifestSource: string
    try {
      manifestSource = await readFile(join(canonical, 'package.json'), 'utf8')
      manifest = JSON.parse(manifestSource) as PackageManifest
    } catch {
      continue
    }
    const name = manifest.name ?? basename(canonical)
    const version = manifest.version ?? 'unknown'
    const identity = [
      name,
      version,
      packageLocationIdentity(profile, canonical),
      createHash('sha256').update(manifestSource).digest('hex'),
    ].join('\0')
    for (const script of SCRIPT_NAMES) {
      if (typeof manifest.scripts?.[script] === 'string' && manifest.scripts[script] !== '') {
        scripts.set(`${identity}\0${script}`, `${name}@${version}:${script}`)
      }
    }
    queue.push(...await packageDirectories(join(canonical, 'node_modules')))
  }
  return scripts
}

function clientExport(manifest: PackageManifest): string | undefined {
  const value = manifest.exports?.['./client']
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'default') === 'string') {
    return Reflect.get(value, 'default') as string
  }
  return undefined
}

async function inspectBundleDependencies(profile: string): Promise<Set<string>> {
  const manifest = await readJson<ProfileManifest>(join(profile, 'package.json'))
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const bundles = new Set<string>()
  for (const name of dependencies) {
    const installed = await directPackage(profile, name)
    const patch = installed.manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') continue
    const packageRoot = dirname(installed.path)
    const patchPath = resolve(packageRoot, patch)
    assertInside(packageRoot, patchPath)
    if (!await isFile(patchPath)) {
      throw new Error(`desktop plugins: ${name} bundle patch is missing: ${patch}`)
    }
    const client = await inspectBundleClients(installed)
    if (client.error !== undefined) throw client.error
    bundles.add(name)
  }
  return bundles
}

/** In-memory owner of resolved plugin transactions. */
export class DesktopPluginManager {
  private readonly staged = new Map<string, StagedTransaction>()
  private readonly applying = new Set<string>()
  private readonly runtime: PluginManagerRuntime

  /**
   * @param hooks - Host and window lifecycle operations owned by the main process.
   * @param runtime - package-manager and dialog dependencies; tests replace them with isolated fakes.
   */
  constructor(
    private readonly hooks: ApplyHooks,
    runtime: Partial<PluginManagerRuntime> = {},
  ) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime }
  }

  /** List dependencies managed by the Desktop profile. */
  async list(): Promise<readonly DesktopPluginInfo[]> {
    return await listAt(profileDir(this.runtime.home()))
  }

  /** Resolve one install/update/remove operation without changing the live profile. */
  async stage(request: DesktopPluginRequest): Promise<DesktopPluginStage> {
    let args: string[]
    let action: DesktopPluginRequest['action']
    if (request.action === 'install') {
      const spec = validateSpec(request.spec)
      action = 'install'
      args = ['add', '--ignore-scripts', '--save-exact', '--', spec]
    } else if (request.action === 'update') {
      const name = validatePackageName(request.name)
      action = 'update'
      args = ['update', '--ignore-scripts', '--latest', '--', name]
    } else {
      const name = validatePackageName(request.name)
      action = 'remove'
      args = ['remove', '--ignore-scripts', '--', name]
    }
    const home = this.runtime.home()
    const live = profileDir(home)
    const baseline = await profileFingerprint(live)
    const before = await readJson<ProfileManifest>(join(live, 'package.json'))
    const baselineScripts = await lifecycleScripts(live)
    const token = randomUUID()
    const managedStagingRoot = stagingRoot(home)
    const root = join(managedStagingRoot, token)
    const profile = join(root, 'profile')
    assertInside(managedStagingRoot, root)
    try {
      await mkdir(profile, { recursive: true, mode: 0o700 })
      for (const entry of await readdir(live, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        await cp(join(live, entry.name), join(profile, entry.name), {
          recursive: entry.isDirectory(),
          dereference: false,
        })
      }
      if (await profileFingerprint(profile) !== baseline) {
        throw new Error('desktop plugins: profile changed while the transaction was being staged')
      }
      await this.runtime.runPackageManager(profile, args)
      const stagedScripts = await lifecycleScripts(profile)
      const introduced = [...stagedScripts]
        .filter(([identity]) => !baselineScripts.has(identity))
        .map(([, label]) => label)
      if (introduced.length > 0) {
        throw new Error(`desktop plugins: install scripts are not allowed:\n${introduced.join('\n')}`)
      }
      const after = await readJson<ProfileManifest>(join(profile, 'package.json'))
      const bundleDependencies = await inspectBundleDependencies(profile)
      const reconciliation = reconcileProfileBundles(before, after, bundleDependencies)
      if (reconciliation.addedPlainDependencies.length > 0) {
        throw new Error(
          `desktop plugins: ${reconciliation.addedPlainDependencies.join(', ')} declares no dsh.bundle.patch`,
        )
      }
      if (request.action === 'update' && !bundleDependencies.has(validatePackageName(request.name))) {
        throw new Error(`desktop plugins: ${request.name} declares no dsh.bundle.patch`)
      }
      if (reconciliation.changed) {
        await writeFile(
          join(profile, 'package.json'),
          `${JSON.stringify(reconciliation.manifest, null, 2)}\n`,
          'utf8',
        )
      }
      const packages = await listAt(profile)
      const summary: DesktopPluginStage = { token, action, packages }
      this.staged.set(token, { token, root, profile, baseline, summary })
      return summary
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  /** Delete an unapplied staging tree. */
  async cancel(token: string): Promise<void> {
    const transaction = this.staged.get(token)
    if (transaction === undefined) return
    if (this.applying.has(token)) throw new Error('desktop plugins: transaction is being applied')
    this.staged.delete(token)
    assertInside(stagingRoot(this.runtime.home()), transaction.root)
    await rm(transaction.root, { recursive: true, force: true })
  }

  /** Apply one resolved transaction with Host-start rollback. */
  async apply(token: string): Promise<void> {
    const transaction = this.staged.get(token)
    if (transaction === undefined) throw new Error('desktop plugins: staged transaction is unavailable')
    if (this.applying.size > 0) throw new Error('desktop plugins: another transaction is being applied')
    const parent = this.hooks.parentWindow()
    const text = labels()
    const options: MessageBoxOptions = {
      type: 'warning',
      buttons: [text.apply, text.cancel],
      defaultId: 1,
      cancelId: 1,
      title: text.title,
      message: text.warning,
      detail: text.detail(transaction.summary.action),
      noLink: true,
    }
    if (!await this.runtime.confirm(parent, options)) return
    if (await profileFingerprint(profileDir(this.runtime.home())) !== transaction.baseline) {
      this.staged.delete(token)
      await rm(transaction.root, { recursive: true, force: true })
      throw new Error('desktop plugins: profile changed since this transaction was resolved; resolve it again')
    }
    const managedStagingRoot = stagingRoot(this.runtime.home())
    const live = profileDir(this.runtime.home())
    const backup = join(managedStagingRoot, `backup-${token}`)
    const failed = join(transaction.root, 'failed-applied')
    assertInside(managedStagingRoot, backup)
    assertInside(managedStagingRoot, failed)
    this.applying.add(token)
    let backupOwnsPrevious = false
    let liveOwnsCandidate = false
    let hostRunning = true
    try {
      await this.hooks.stopHost()
      hostRunning = false
      await rename(live, backup)
      backupOwnsPrevious = true
      await rename(transaction.profile, live)
      liveOwnsCandidate = true
      await this.hooks.startHost()
      hostRunning = true
    } catch (error) {
      const recoveryErrors: unknown[] = []
      if (!hostRunning) {
        await this.hooks.stopHost()
          .catch((recoveryError: unknown) => { recoveryErrors.push(recoveryError) })
        if (liveOwnsCandidate) {
          await rename(live, failed)
            .then(() => { liveOwnsCandidate = false })
            .catch((recoveryError: unknown) => { recoveryErrors.push(recoveryError) })
        }
        if (backupOwnsPrevious && !await exists(live)) {
          await rename(backup, live)
            .then(() => { backupOwnsPrevious = false })
            .catch((recoveryError: unknown) => { recoveryErrors.push(recoveryError) })
        }
        if (!backupOwnsPrevious && await exists(live)) {
          await this.hooks.startHost()
            .then(() => { hostRunning = true })
            .catch((recoveryError: unknown) => { recoveryErrors.push(recoveryError) })
        }
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          'desktop plugins: profile replacement failed and recovery did not complete',
        )
      }
      this.hooks.reloadWindows()
      this.staged.delete(token)
      await rm(transaction.root, { recursive: true, force: true })
      throw new Error('desktop plugins: the new profile failed to start and was rolled back', { cause: error })
    } finally {
      this.applying.delete(token)
    }
    this.hooks.reloadWindows()
    this.staged.delete(token)
    await rm(backup, { recursive: true, force: true })
      .catch((error: unknown) => { console.error(error) })
    await rm(transaction.root, { recursive: true, force: true })
      .catch((error: unknown) => { console.error(error) })
  }
}
