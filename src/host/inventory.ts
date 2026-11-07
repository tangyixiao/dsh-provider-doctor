/**
 * Plugin install state, read from the three places the host exposes it.
 *
 * Each source is weaker than the one before it, and the strength is carried in
 * the result rather than flattened away:
 *
 * 1. **`pluginInventory`** — the live loader snapshot, mounted by the Web and
 *    Desktop compositions. It lists every entry the running host holds, with
 *    its enabled flag and its fiber phase. This is the only source that can say
 *    "installed and active" without inferring anything.
 * 2. **`loader`** — the entry table, used *only* when the inventory gateway is
 *    absent. A loader row names the plugin by its Cordis name, which for some
 *    packages differs from the npm package name, so a hit here is reported as
 *    `loader` and every check built on it is marked `inferred`.
 * 3. **`<profileDir>/package.json`** — the profile's dependency records. This
 *    is `local_metadata`: it proves the profile declares the package, not that
 *    the files are on disk or that the host loaded them.
 *
 * A headless host may expose none of them. That is a reportable state
 * (`inventory_unavailable`), never an exception: `resolvePluginState` answers
 * `present: undefined` and the caller says "could not confirm".
 *
 * @module dsh-provider-doctor/host/inventory
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  HostServices,
  LoaderEntryLike,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '../providers/types.ts'

/** Which source produced an install verdict. */
export type PluginStateSource = 'inventory' | 'loader' | 'manifest' | 'unavailable'

/** What is known about one plugin's installation. */
export interface ResolvedPluginState {
  /** `true` installed, `false` not installed, `undefined` could not be determined. */
  present: boolean | undefined
  /** The live inventory row, when one matched. */
  entry?: PluginInventoryEntry
  /** Where {@link present} came from. */
  source: PluginStateSource
}

/** The evidence one install verdict may be built from. */
export interface PluginEvidence {
  /** npm package name to look for. */
  packageName: string
  /** The live snapshot, or `undefined` when this host has no inventory service. */
  inventory: PluginInventorySnapshot | undefined
  /** The profile's dependency records, or `undefined` when unreadable. */
  dependencies: Record<string, string> | undefined
}

/** The profile manifest file every profile carries. */
const PROFILE_MANIFEST = 'package.json'

/** Dependency sections a plugin may be declared in. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'] as const

/** The only fiber phases the inventory contract defines. */
const FIBER_PHASES: ReadonlySet<string> = new Set(['failed', 'active', 'pending', 'loading', 'unloading'])

/**
 * Read the live plugin inventory.
 *
 * The service is optional: it is mounted by `dsh-web-app`, so a headless
 * composition simply does not have it. A rejection is treated the same way as
 * absence — an inventory that cannot be read is not evidence of anything, and
 * the caller must not mistake it for an empty table.
 *
 * @param host - The services this run was given.
 * @returns A normalised snapshot, or `undefined` when none could be read.
 */
export async function readInventory(host: HostServices): Promise<PluginInventorySnapshot | undefined> {
  const service = host.pluginInventory
  if (service === undefined) return undefined
  try {
    return normaliseSnapshot(await service.list())
  } catch {
    return undefined
  }
}

/**
 * Reduce an untrusted inventory document to the contract's shape.
 *
 * Rows without a string `moduleName`/`entryId` or a boolean `enabled` are
 * dropped rather than repaired: defaulting `enabled` would manufacture a
 * verdict, and a fabricated verdict is worse than a missing row.
 */
function normaliseSnapshot(value: unknown): PluginInventorySnapshot | undefined {
  const root = asRecord(value)
  if (root === undefined) return undefined
  const rows = root['entries']
  if (!Array.isArray(rows)) return undefined

  const entries: PluginInventoryEntry[] = []
  for (const row of rows) {
    const entry = normaliseEntry(row)
    if (entry !== undefined) entries.push(entry)
  }

  const snapshot: PluginInventorySnapshot = { entries }
  const managementAvailable = root['managementAvailable']
  if (typeof managementAvailable === 'boolean') snapshot.managementAvailable = managementAvailable
  return snapshot
}

/** Reduce one untrusted inventory row, or drop it. */
function normaliseEntry(value: unknown): PluginInventoryEntry | undefined {
  const row = asRecord(value)
  if (row === undefined) return undefined
  const entryId = row['entryId']
  const moduleName = row['moduleName']
  const enabled = row['enabled']
  if (typeof entryId !== 'string' || typeof moduleName !== 'string' || typeof enabled !== 'boolean') {
    return undefined
  }

  const phase = row['fiberPhase']
  const fiberPhase: PluginInventoryEntry['fiberPhase'] =
    typeof phase === 'string' && FIBER_PHASES.has(phase)
      ? (phase as NonNullable<PluginInventoryEntry['fiberPhase']>)
      : null

  const entry: PluginInventoryEntry = {
    entryId,
    moduleName,
    enabled,
    fiberPhase,
  }
  const diagnostic = row['diagnostic']
  if (typeof diagnostic === 'string') entry.diagnostic = diagnostic
  const meta = normaliseMeta(row['meta'])
  if (meta !== undefined) entry.meta = meta
  return entry
}

/** Keep only the four meta fields the contract names, each a string. */
function normaliseMeta(value: unknown): PluginInventoryEntry['meta'] | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const meta: NonNullable<PluginInventoryEntry['meta']> = {}
  for (const key of ['title', 'description', 'icon', 'error'] as const) {
    const field = record[key]
    if (typeof field === 'string') meta[key] = field
  }
  return Object.keys(meta).length === 0 ? undefined : meta
}

/**
 * Find the inventory row for one npm package.
 *
 * `moduleName` is the package name and is matched first. `entryId` is a loader
 * row id — often the package name, sometimes a generated one — so it is only
 * consulted after every row's `moduleName` has been ruled out. Matching it
 * first would let a row whose id happens to collide with another package's name
 * win over the row that actually is that package.
 *
 * @param snapshot - The live snapshot, when this host has one.
 * @param packageName - npm package name to find.
 * @returns The matching row, or `undefined`.
 */
export function findEntryByPackage(
  snapshot: PluginInventorySnapshot | undefined,
  packageName: string,
): PluginInventoryEntry | undefined {
  if (snapshot === undefined) return undefined
  const byModule = snapshot.entries.find((entry) => entry.moduleName === packageName)
  if (byModule !== undefined) return byModule
  return snapshot.entries.find((entry) => entry.entryId === packageName)
}

/**
 * Read the profile's dependency records.
 *
 * The profile manifest is the only local document that says which packages this
 * profile is supposed to load. Both dependency sections are merged, because a
 * development profile legitimately puts provider plugins in `devDependencies`;
 * later sections do not override earlier ones, so a package declared with a
 * different range in both keeps the `dependencies` range.
 *
 * @param profileDir - Absolute profile directory, when one was resolved.
 * @returns A package-name to range map, or `undefined` when unreadable.
 */
export function readProfileDependencies(profileDir: string | undefined): Record<string, string> | undefined {
  if (profileDir === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(profileDir, PROFILE_MANIFEST), 'utf8')) as unknown
  } catch {
    return undefined
  }
  const root = asRecord(parsed)
  if (root === undefined) return undefined

  const dependencies: Record<string, string> = {}
  let readable = false
  for (const section of DEPENDENCY_SECTIONS) {
    const block = asRecord(root[section])
    if (block === undefined) continue
    readable = true
    for (const [name, range] of Object.entries(block)) {
      if (typeof range === 'string' && dependencies[name] === undefined) dependencies[name] = range
    }
  }
  // A manifest with neither section parsed is not a manifest we understood:
  // returning `{}` would read as "it declares nothing", which is a verdict.
  return readable ? dependencies : undefined
}

/**
 * Decide install state from evidence the caller already holds.
 *
 * This is the synchronous half of {@link resolvePluginState}, shared with the
 * provider checks so an adapter that already read the inventory does not have
 * to read it again — and so both paths reach the same verdict.
 *
 * @param evidence - Snapshot, dependency records and the package to look for.
 * @returns The verdict, with the source that produced it.
 */
export function resolvePluginStateFromEvidence(evidence: PluginEvidence): ResolvedPluginState {
  const entry = findEntryByPackage(evidence.inventory, evidence.packageName)
  if (entry !== undefined) return { present: true, entry, source: 'inventory' }

  if (evidence.dependencies !== undefined && hasOwn(evidence.dependencies, evidence.packageName)) {
    return { present: true, source: 'manifest' }
  }

  // An inventory that reports `managementAvailable: false` is a partial view:
  // it may only contain loaded entries, so a missing row says nothing.
  if (evidence.inventory !== undefined && evidence.inventory.managementAvailable !== false) {
    return { present: false, source: 'inventory' }
  }

  if (evidence.dependencies !== undefined) return { present: false, source: 'manifest' }

  return { present: undefined, source: 'unavailable' }
}

/**
 * Resolve one plugin's install state, consulting every available source.
 *
 * The loader is asked only when the inventory service is missing: two live
 * tables disagreeing about the same process would be a bug, and preferring the
 * richer one keeps the verdict stable.
 *
 * @param host - The services this run was given.
 * @param profileDir - The running profile directory, when known.
 * @param packageName - npm package name to look for.
 * @returns The verdict; never throws.
 */
export async function resolvePluginState(
  host: HostServices,
  profileDir: string | undefined,
  packageName: string,
): Promise<ResolvedPluginState> {
  const inventory = await readInventory(host)
  const dependencies = readProfileDependencies(profileDir)
  const verdict = resolvePluginStateFromEvidence({ packageName, inventory, dependencies })
  if (inventory !== undefined) return verdict

  const fromLoader = readLoaderEntry(host, packageName)
  if (fromLoader !== undefined) return { present: true, entry: fromLoader, source: 'loader' }
  return verdict
}

/**
 * Look the package up in the loader's entry table.
 *
 * A loader row carries the plugin's Cordis name (`options.name`) or a row id
 * (`options.id`); neither is guaranteed to equal the npm package name. A miss
 * therefore means "this table does not mention it", not "it is not installed",
 * which is why the caller labels a hit `loader` and the checks mark it
 * `inferred`.
 *
 * `fiber.state` is deliberately left unread. Cordis declares it as a numeric
 * const enum internal to that package; this plugin does not import it and will
 * not guess the numbers, so the synthesized row reports `fiberPhase: null` —
 * "not observable from here" — instead of a fabricated `active`.
 */
function readLoaderEntry(host: HostServices, packageName: string): PluginInventoryEntry | undefined {
  const loader = host.loader
  if (loader === undefined) return undefined
  let entries: Iterable<LoaderEntryLike>
  try {
    entries = loader.entries()
  } catch {
    return undefined
  }
  try {
    for (const entry of entries) {
      const options = entry.options
      if (options === undefined || options.group === true) continue
      const name = options.name ?? options.id
      if (name !== packageName) continue
      return {
        entryId: options.id ?? options.name ?? packageName,
        moduleName: packageName,
        enabled: entry.disabled !== true,
        fiberPhase: null,
      }
    }
  } catch {
    // A table that throws mid-iteration is not evidence; fall through.
    return undefined
  }
  return undefined
}

/** Is this key an own property? Prototype names must not count as declared. */
function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** Read one plain record, or nothing when the value is not an object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
