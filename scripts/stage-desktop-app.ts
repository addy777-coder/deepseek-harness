/** Stage a workspace-independent electron-builder project under .dsh-build. */
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { verifyVpnArtifact } from '../apps/desktop/src/main/vpn-artifact.ts'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'apps/desktop')
const staging = resolve(root, '.dsh-build/desktop-app')
const vpnSource = resolve(root, 'native/vpn/dist/windows-x64')
await verifyVpnArtifact(vpnSource, true)

const rel = relative(root, staging)
if (rel !== `.dsh-build${sep}desktop-app`) {
  throw new Error(`stage-desktop-app: refusing unexpected staging path ${staging}`)
}

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
for (const entry of ['lib', 'dist', 'assets', 'electron-builder.yml']) {
  await cp(join(source, entry), join(staging, entry), { recursive: true, dereference: true })
}
await cp(vpnSource, join(staging, 'vpn'), { recursive: true })

const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
  name: string
  description: string
  version: string
  type: string
  main: string
}
await writeFile(join(staging, 'package.json'), `${JSON.stringify({
  name: sourceManifest.name,
  description: sourceManifest.description,
  version: sourceManifest.version,
  private: true,
  type: sourceManifest.type,
  main: sourceManifest.main,
  packageManager: 'pnpm@11.7.0',
}, null, 2)}\n`)
await writeFile(join(staging, 'pnpm-workspace.yaml'), 'packages: []\n')

const pnpm = await realpath(join(source, 'node_modules/pnpm'))
const nestedNodeModules = join(pnpm, 'node_modules')
await cp(pnpm, join(staging, 'pnpm'), {
  recursive: true,
  dereference: true,
  filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
})
console.log(`stage-desktop-app: staged ${staging}`)
