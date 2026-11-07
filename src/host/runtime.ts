/**
 * Host facts: which DSH build is running, where its home is, and which profile
 * the evidence belongs to.
 *
 * Everything here is synchronous, offline and total: a diagnostic that throws
 * while asking "which version am I running on" would hide the very problem it
 * exists to find. Nothing is guessed. If the DSH version cannot be read, the
 * field stays absent and {@link HostFacts.dshVersionSource} says `unavailable`;
 * a fabricated version would make every later check agree with a fiction.
 *
 * @module dsh-provider-doctor/host/runtime
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { EvidenceKind } from '../shared/contract.ts'

/** Where the reported DSH version came from. */
export type HostVersionSource = 'injected' | 'package-manifest' | 'unavailable'

/** Everything the doctor reports about the host machine, read once per run. */
export interface HostFacts {
  /** The authoritative DSH build, when it could be read. Never a placeholder. */
  dshVersion?: string
  /** Which of the two sources produced {@link dshVersion}. */
  dshVersionSource: HostVersionSource
  /** `process.version`, e.g. `v22.19.0`. */
  nodeVersion: string
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** Absolute DSH home directory this run reads from. */
  dshHome: string
}

/** What the caller may override when it already knows a fact. */
export interface HostFactsInput {
  /** The DSH version as the host itself reports it. */
  dshVersion?: string
  /** The DSH home directory, when the caller resolved it itself. */
  dshHome?: string
}

/** How the running profile was located. */
export type ProfileResolution =
  /** The caller told us the name. */
  | 'injected'
  /** `DSH_PROFILE` (or a `DSH_HOME` that points into `profiles/`) named it. */
  | 'env'
  /** `--profile <name>` on the command line named it. */
  | 'argv'
  /** Exactly one profile directory exists, so there is nothing to choose. */
  | 'single-profile'
  /** Several exist and `desktop` was present; that one is presumed live. */
  | 'preferred-desktop'
  /** Several exist and none is `desktop`; no honest choice can be made. */
  | 'ambiguous'
  /** The profile directory could not be read at all. */
  | 'unavailable'

/** Everything the doctor reports about the running profile. */
export interface ProfileFacts {
  /** The profile *name* only — never an absolute path. */
  name?: string
  /** Absolute profile directory, used internally and redacted before display. */
  dir?: string
  /** Every candidate profile name that was visible, sorted. */
  candidates: readonly string[]
  /** Detailed provenance; {@link evidence} is the strength derived from it. */
  source: ProfileResolution
  /** Whether the name was read directly, inferred, or is unavailable. */
  evidence: EvidenceKind
}

/** The directory name DSH puts profiles under. */
const PROFILES_DIRECTORY = 'profiles'

/** The profile the Desktop app creates and uses. */
const PREFERRED_PROFILE = 'desktop'

/** The package whose manifest carries the authoritative DSH version. */
const DSH_BOOT_MANIFEST = '@deepseek-ai/dsh-app-boot/package.json'

/** Entries under `profiles/` that are never a profile. */
const EXCLUDED_PROFILE_ENTRIES: ReadonlySet<string> = new Set(['node_modules'])

/**
 * Read every host fact that does not require the caller to know anything.
 *
 * The DSH version has two sources, in order: what the caller injected (the
 * host already knows, because it booted through `dsh-app-boot`), then the
 * `@deepseek-ai/dsh-app-boot` manifest resolvable from this file. The manifest
 * is *not* a declared dependency of this plugin — it is resolved best-effort,
 * which is exactly why a failure here degrades to `unavailable` instead of
 * failing the run.
 *
 * @param input - Facts the caller already knows.
 * @returns A complete host snapshot; never throws.
 */
export function readHostFacts(input?: HostFactsInput): HostFacts {
  const injectedVersion = nonEmpty(input?.dshVersion)
  const manifestVersion = injectedVersion === undefined ? readBootManifestVersion() : undefined
  const dshVersion = injectedVersion ?? manifestVersion
  const dshVersionSource: HostVersionSource =
    injectedVersion !== undefined ? 'injected' : manifestVersion !== undefined ? 'package-manifest' : 'unavailable'

  const facts: HostFacts = {
    dshVersionSource,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    dshHome: resolveDshHome(input?.dshHome),
  }
  if (dshVersion !== undefined) facts.dshVersion = dshVersion
  return facts
}

/**
 * Resolve the DSH home directory.
 *
 * `DSH_HOME` is authoritative when set because that is what the host itself
 * honoured when it loaded this plugin; otherwise DSH's documented default of
 * `~/.dsh` applies.
 */
function resolveDshHome(injected: string | undefined): string {
  const explicit = nonEmpty(injected) ?? nonEmpty(process.env['DSH_HOME'])
  if (explicit !== undefined) {
    try {
      return resolve(explicit)
    } catch {
      return explicit
    }
  }
  try {
    return join(homedir(), '.dsh')
  } catch {
    return '.dsh'
  }
}

/**
 * Read `version` out of the resolvable `dsh-app-boot` manifest.
 *
 * Both the resolution and the parse are best-effort: a bundler that inlined
 * this plugin, a relocated install, or a manifest without a version all yield
 * `undefined`, and the caller reports `host_version_unreadable`.
 */
function readBootManifestVersion(): string | undefined {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const manifestPath = requireFromHere.resolve(DSH_BOOT_MANIFEST)
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? nonEmpty(version) : undefined
  } catch {
    return undefined
  }
}

/** How {@link discoverProfile} may be steered, for tests and for the runner. */
export interface ProfileDiscoveryOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Command line to read; defaults to `process.argv`. */
  argv?: readonly string[]
}

/**
 * Locate the profile that is actually running.
 *
 * The public DSH surface does not expose the live profile name, so the name is
 * derived from the strongest available signal and the *strength is recorded*:
 *
 * 1. an injected name — the caller knows;
 * 2. `DSH_PROFILE`, or a `DSH_HOME` that itself points inside `profiles/`;
 * 3. `--profile <name>` / `--profile=<name>` on the command line;
 * 4. the only directory under `<dshHome>/profiles`;
 * 5. `desktop` among several — the Desktop app's profile — marked `inferred`;
 * 6. nothing: several candidates without `desktop`, or an unreadable directory.
 *
 * Step 6 deliberately does not pick a winner. A "best guess" profile would make
 * every later check read the wrong plugin table and report a confident,
 * wrong answer; `profile_unresolved` is the honest outcome.
 *
 * @param dshHome - The DSH home directory to inspect.
 * @param injectedName - A profile name or directory the caller already knows.
 * @param options - Environment and argv overrides (used by tests).
 * @returns The profile facts; never throws.
 */
export function discoverProfile(
  dshHome: string,
  injectedName?: string,
  options?: ProfileDiscoveryOptions,
): ProfileFacts {
  const env = options?.env ?? process.env
  const argv = options?.argv ?? process.argv
  const candidates = listProfileCandidates(dshHome)

  const injected = interpretProfileValue(injectedName, dshHome)
  if (injected !== undefined) {
    return makeProfileFacts(injected.name, injected.dir, candidates, 'injected', 'observed')
  }

  const fromEnv = profileFromEnvironment(env, dshHome)
  if (fromEnv !== undefined) {
    return makeProfileFacts(fromEnv.name, fromEnv.dir, candidates, 'env', 'observed')
  }

  const fromArgv = interpretProfileValue(readProfileArg(argv), dshHome)
  if (fromArgv !== undefined) {
    return makeProfileFacts(fromArgv.name, fromArgv.dir, candidates, 'argv', 'observed')
  }

  if (candidates.length === 1) {
    const only = candidates[0]
    if (only !== undefined) {
      return makeProfileFacts(only, join(dshHome, PROFILES_DIRECTORY, only), candidates, 'single-profile', 'observed')
    }
  }
  if (candidates.includes(PREFERRED_PROFILE)) {
    return makeProfileFacts(
      PREFERRED_PROFILE,
      join(dshHome, PROFILES_DIRECTORY, PREFERRED_PROFILE),
      candidates,
      'preferred-desktop',
      'inferred',
    )
  }
  if (candidates.length > 1) {
    return makeProfileFacts(undefined, undefined, candidates, 'ambiguous', 'unavailable')
  }
  return makeProfileFacts(undefined, undefined, candidates, 'unavailable', 'unavailable')
}

/** Build {@link ProfileFacts} without ever writing an explicit `undefined`. */
function makeProfileFacts(
  name: string | undefined,
  dir: string | undefined,
  candidates: readonly string[],
  source: ProfileResolution,
  evidence: EvidenceKind,
): ProfileFacts {
  const facts: ProfileFacts = { candidates, source, evidence }
  if (name !== undefined) facts.name = name
  if (dir !== undefined) facts.dir = dir
  return facts
}

/**
 * List the profile directory names under `<dshHome>/profiles`.
 *
 * Only directories count: a stray file in that folder is not a profile. A
 * missing or unreadable directory yields an empty list, which the caller turns
 * into `profile_unresolved` rather than an error.
 */
function listProfileCandidates(dshHome: string): string[] {
  try {
    const entries = readdirSync(join(dshHome, PROFILES_DIRECTORY), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !EXCLUDED_PROFILE_ENTRIES.has(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Read a profile name out of the environment.
 *
 * `DSH_HOME` is only treated as a profile when it points at a directory whose
 * parent is named `profiles`; otherwise it is the home, not the profile.
 */
function profileFromEnvironment(
  env: NodeJS.ProcessEnv,
  dshHome: string,
): { name: string; dir: string } | undefined {
  const fromProfileVar = interpretProfileValue(env['DSH_PROFILE'], dshHome)
  if (fromProfileVar !== undefined) return fromProfileVar

  const envHome = nonEmpty(env['DSH_HOME'])
  if (envHome === undefined) return undefined
  try {
    const resolved = resolve(envHome)
    if (basename(dirname(resolved)) !== PROFILES_DIRECTORY) return undefined
    const name = basename(resolved)
    return name === '' ? undefined : { name, dir: resolved }
  } catch {
    return undefined
  }
}

/** Read `--profile <name>` / `--profile=<name>` out of a command line. */
function readProfileArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--profile') {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) return next
      continue
    }
    if (token.startsWith('--profile=')) {
      const value = token.slice('--profile='.length)
      if (value !== '') return value
    }
  }
  return undefined
}

/**
 * Turn a name-or-path into a profile name plus its directory.
 *
 * DSH's `profile.identity` is the *name*; the directory is only ever carried in
 * redacted details. A path that points outside this DSH home is still accepted
 * by name, because the caller is asserting it, not guessing it.
 */
function interpretProfileValue(
  value: string | undefined,
  dshHome: string,
): { name: string; dir: string } | undefined {
  const trimmed = nonEmpty(value)
  if (trimmed === undefined) return undefined
  const looksLikePath = isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')
  if (!looksLikePath) return { name: trimmed, dir: join(dshHome, PROFILES_DIRECTORY, trimmed) }
  const name = basename(trimmed)
  if (name === '' || name === '.' || name === '..') return undefined
  try {
    return { name, dir: resolve(trimmed) }
  } catch {
    return undefined
  }
}

/** A trimmed, non-empty string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** One release tuple with its optional prerelease identifiers. */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** How many numeric parts the input actually wrote (1-3). */
  specified: 1 | 2 | 3
  /** Dot-separated prerelease identifiers (`rc`, `1`, `alpha`, …), empty when none. */
  prerelease: readonly (string | number)[]
}

/** `<op> <version>`, the only range primitive this file needs. */
interface Comparator {
  op: '>=' | '<=' | '>' | '<' | '='
  version: ParsedVersion
}

/** `0.1.x || ^0.2.1` — alternatives of ANDed comparators. */
interface ParsedRange {
  alternatives: Comparator[][]
}

/** `v?x[.y[.z]][-prerelease][+build]`. */
const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** The operators a bare comparator may start with, longest first. */
const COMPARATOR_OPERATORS: readonly Comparator['op'][] = ['>=', '<=', '>', '<', '=']

/**
 * Parse one version.
 *
 * A leading `v` and build metadata (`+sha`) are accepted and ignored; a missing
 * minor or patch is padded with zero, which matches npm's reading of `^0.2` and
 * `~0.2` for the bounds this file emits.
 */
function parseVersion(input: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(input.trim())
  if (match === null) return undefined
  const majorText = match[1]
  if (majorText === undefined) return undefined
  const minorText = match[2]
  const patchText = match[3]
  const prereleaseText = match[4]

  const major = Number(majorText)
  const minor = minorText === undefined ? 0 : Number(minorText)
  const patch = patchText === undefined ? 0 : Number(patchText)
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined

  const specified: 1 | 2 | 3 = patchText !== undefined ? 3 : minorText !== undefined ? 2 : 1
  const prerelease: (string | number)[] = []
  if (prereleaseText !== undefined) {
    for (const identifier of prereleaseText.split('.')) {
      if (identifier === '') return undefined
      prerelease.push(/^\d+$/.test(identifier) ? Number(identifier) : identifier)
    }
  }
  return { major, minor, patch, specified, prerelease }
}

/**
 * Order two versions using semver precedence.
 *
 * Prerelease precedence, as semver defines it and this file relies on:
 * `0.2.2-rc.1 < 0.2.2`, and within one release `rc.1 < rc.2`. Identifiers are
 * compared left to right; a numeric identifier sorts below an alphanumeric one;
 * when every shared identifier is equal, the shorter prerelease sorts first.
 * Build metadata is not part of precedence and was already dropped by the
 * parser.
 */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** Compare two prerelease identifier lists; an empty list outranks any list. */
function comparePrerelease(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  if (left.length === 0 && right.length === 0) return 0
  // A release outranks every prerelease of the same tuple.
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) continue
    const ordering = compareIdentifier(a, b)
    if (ordering !== 0) return ordering
  }
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

/** Numeric identifiers sort numerically and below alphanumeric ones. */
function compareIdentifier(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) return 0
    return left < right ? -1 : 1
  }
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** A synthetic upper bound: `<x.y.z-0` excludes prereleases of the next tuple. */
function exclusiveUpper(major: number, minor: number, patch: number): ParsedVersion {
  return { major, minor, patch, specified: 3, prerelease: [0] }
}

/** The upper bound of `^version`, mirroring npm's caret desugaring. */
function caretUpper(version: ParsedVersion): ParsedVersion {
  if (version.major > 0) return exclusiveUpper(version.major + 1, 0, 0)
  if (version.minor > 0) return exclusiveUpper(0, version.minor + 1, 0)
  if (version.specified >= 3) return exclusiveUpper(0, 0, version.patch + 1)
  if (version.specified === 2) return exclusiveUpper(0, 1, 0)
  return exclusiveUpper(1, 0, 0)
}

/** The upper bound of `~version`, mirroring npm's tilde desugaring. */
function tildeUpper(version: ParsedVersion): ParsedVersion {
  if (version.specified >= 2) return exclusiveUpper(version.major, version.minor + 1, 0)
  return exclusiveUpper(version.major + 1, 0, 0)
}

/**
 * Parse one range alternative: `^0.2.1`, `~0.2.3`, `>=0.2.0 <0.3.0`, `0.2.2-rc.1`.
 *
 * Only the grammar this plugin's `engines` field and its own calls use is
 * accepted. Anything else returns `undefined` instead of being interpreted as
 * something the caller did not ask for.
 */
function parseAlternative(input: string): Comparator[] | undefined {
  const comparators: Comparator[] = []
  for (const token of input.split(/\s+/)) {
    if (token === '') continue
    // `*` is the one wildcard this plugin's fallback range uses. It means "no
    // claim", which an empty comparator list expresses exactly; returning a
    // comparator that always holds would say the same thing less clearly.
    if (token === '*') {
      comparators.push({ op: '>=', version: { major: 0, minor: 0, patch: 0, specified: 3, prerelease: [] } })
      continue
    }
    if (token.startsWith('^')) {
      const version = parseVersion(token.slice(1))
      if (version === undefined) return undefined
      comparators.push({ op: '>=', version }, { op: '<', version: caretUpper(version) })
      continue
    }
    if (token.startsWith('~')) {
      const version = parseVersion(token.slice(1))
      if (version === undefined) return undefined
      comparators.push({ op: '>=', version }, { op: '<', version: tildeUpper(version) })
      continue
    }
    const operator = COMPARATOR_OPERATORS.find((candidate) => token.startsWith(candidate))
    if (operator !== undefined) {
      const version = parseVersion(token.slice(operator.length))
      if (version === undefined) return undefined
      comparators.push({ op: operator, version })
      continue
    }
    const exact = parseVersion(token)
    if (exact === undefined) return undefined
    comparators.push({ op: '=', version: exact })
  }
  return comparators.length === 0 ? undefined : comparators
}

/** Parse a whole range, including `||` alternatives. */
function parseRange(input: string): ParsedRange | undefined {
  const alternatives: Comparator[][] = []
  for (const alternative of input.split('||')) {
    const parsed = parseAlternative(alternative.trim())
    if (parsed === undefined) return undefined
    alternatives.push(parsed)
  }
  return alternatives.length === 0 ? undefined : { alternatives }
}

/** Does one comparator accept this version? */
function satisfiesComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const ordering = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '>=':
      return ordering >= 0
    case '<=':
      return ordering <= 0
    case '>':
      return ordering > 0
    case '<':
      return ordering < 0
    case '=':
      return ordering === 0
  }
}

/**
 * Is this host version inside the range the plugin was verified against?
 *
 * The real semver package is deliberately not a dependency of this plugin, so
 * a *subset* of npm's range grammar is implemented here. It matches
 * `semver.satisfies(version, range, { includePrerelease: true })` for:
 *
 * - `||` alternatives, and space-separated ANDed comparators;
 * - `>=`, `<=`, `>`, `<`, `=`, and a bare exact version;
 * - `^x.y.z` and `~x.y.z`, desugared to the same bounds npm emits, including
 *   the `-0` upper bound that keeps the next tuple's prereleases out;
 * - prereleases anywhere, ordered by semver precedence
 *   (`0.2.2-rc.1 < 0.2.2`, `rc.1 < rc.2`);
 * - `v` prefixes and `+build` metadata, both ignored.
 *
 * It does *not* implement `*` / `x` / `X` wildcards, hyphen ranges
 * (`1.2.3 - 2.3.4`), `!=`, `~>`/loose operators, or npm's
 * "a prerelease only satisfies a range whose comparator shares its
 * major.minor.patch" rule — `includePrerelease: true` turns that rule off,
 * which is exactly why plain interval comparison is faithful here.
 *
 * @param dshVersion - The version the host reported.
 * @param range - A range from this plugin's `engines` field.
 * @returns `ok` plus, when it is not satisfied, a machine-readable reason.
 */
export function checkEngineRange(dshVersion: string, range: string): { ok: boolean; reason?: string } {
  const version = parseVersion(dshVersion)
  if (version === undefined) return { ok: false, reason: 'invalid_version' }
  const parsed = parseRange(range)
  if (parsed === undefined) return { ok: false, reason: 'invalid_range' }
  for (const alternative of parsed.alternatives) {
    if (alternative.every((comparator) => satisfiesComparator(version, comparator))) return { ok: true }
  }
  return { ok: false, reason: 'out_of_range' }
}
