/** Pure reconciliation between profile dependencies and active bundle layers. */
import type { ProfileManifest } from './profile.ts'
export type { ProfileManifest } from './profile.ts'

/** Result of reconciling one package-manager operation. */
export interface ProfileBundleReconciliation {
  /** Manifest with the reconciled ordered bundle list. */
  readonly manifest: ProfileManifest
  /** Whether the caller must persist {@link manifest}. */
  readonly changed: boolean
  /** Installed dependencies appended to the profile's bundle list. */
  readonly addedBundles: readonly string[]
  /** Dependency-managed bundle rows removed from the profile. */
  readonly removedBundles: readonly string[]
  /** Newly installed dependencies that do not declare a bundle patch. */
  readonly addedPlainDependencies: readonly string[]
}

/**
 * Reconcile dependency-managed bundle rows after a successful package-manager operation.
 * @param before - profile manifest captured before the package-manager operation.
 * @param after - profile manifest written by the package manager.
 * @param bundleDependencies - installed direct dependencies whose manifests declare a bundle patch.
 * @returns the next manifest and a complete summary; this function performs no I/O.
 */
export function reconcileProfileBundles(
  before: ProfileManifest,
  after: ProfileManifest,
  bundleDependencies: ReadonlySet<string>,
): ProfileBundleReconciliation {
  const beforeDependencies = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const dependencySet = new Set(dependencies)
  const bundles = [...after.dsh?.profile?.bundles ?? []]
  const addedBundles: string[] = []
  const removedBundles: string[] = []
  const addedPlainDependencies: string[] = []

  for (const packageName of dependencies) {
    const bundle = bundleDependencies.has(packageName)
    if (bundle && !bundles.includes(packageName)) {
      bundles.push(packageName)
      addedBundles.push(packageName)
    } else if (!bundle && !beforeDependencies.has(packageName)) {
      addedPlainDependencies.push(packageName)
    }
  }

  for (const packageName of [...bundles]) {
    const managed = beforeDependencies.has(packageName) || dependencySet.has(packageName)
    const retained = dependencySet.has(packageName) && bundleDependencies.has(packageName)
    if (!managed || retained) continue
    bundles.splice(bundles.indexOf(packageName), 1)
    removedBundles.push(packageName)
  }

  const changed = addedBundles.length > 0 || removedBundles.length > 0
  const manifest = changed
    ? {
      ...after,
      dsh: { ...after.dsh, profile: { ...after.dsh?.profile, bundles } },
    }
    : after
  return { manifest, changed, addedBundles, removedBundles, addedPlainDependencies }
}
