/**
 * Static facts about the npm package that owns both WorkBuddy provider routes,
 * plus tolerant readers for the two JSON documents its CLI prints.
 *
 * Everything in this module treats the CLI's output as untrusted input. The
 * detailed `doctor --json` document carries absolute paths and a pid, so the
 * readers below expose only individually named, low-risk fields: the adapter
 * builds its detail objects from an explicit whitelist and never spreads a
 * parsed document into a report.
 *
 * @module dsh-provider-doctor/providers/workbuddy/plugin-package
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { AdapterContext } from '../types.ts'
import { REASON_CODES, type ReasonCode } from '../../shared/reason-codes.ts'

/**
 * The npm package that registers both provider routes.
 *
 * One package owns `workbuddy` and `workbuddy-ai`; the two adapters differ only
 * by the variant id they pass to the CLI, so install/enable evidence is shared.
 */
export const WORKBUDDY_PACKAGE = 'dsh-workbuddy-connect-community'

/** The package's bin entry, as declared in its manifest. */
export const WORKBUDDY_CLI_BIN = 'dsh-workbuddy-connect-community'

/** The Cordis plugin name exported by the package, useful for human copy only. */
export const WORKBUDDY_CORDIS_NAME = 'llm-workbuddy'

/** One WorkBuddy product variant, as far as the doctor cares. */
export interface WorkBuddyVariantSpec {
  /** The `ProviderId` this variant registers. */
  readonly id: 'workbuddy' | 'workbuddy-ai'
  /** Human-facing product name, identical to the plugin's own descriptor. */
  readonly displayName: string
  /** The `--provider` value the CLI resolves to this variant. */
  readonly cliProviderId: string
}

/** Both variants, in the order the plugin registers them. */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariantSpec[] = [
  { id: 'workbuddy', displayName: 'WorkBuddy', cliProviderId: 'workbuddy' },
  { id: 'workbuddy-ai', displayName: 'WorkBuddy AI', cliProviderId: 'workbuddy-ai' },
]

/** Look one variant up by provider id. */
export function workbuddyVariantFor(id: string): WorkBuddyVariantSpec | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}

/**
 * The CLI's closed set of sign-out reason codes.
 *
 * The codes are stable strings the plugin already documents; anything outside
 * this list is treated as an unexpected value rather than echoed.
 */
export const WORKBUDDY_CLI_REASON_CODES = [
  'no-credential',
  'encrypted-credential-unreadable',
  'electron-binary-not-found',
  'electron-binary-ambiguous',
  'electron-binary-unavailable',
  'electron-path-invalid',
  'electron-discovery-incomplete',
  'credential-region-mismatch',
] as const

/** One reason code the WorkBuddy CLI can report. */
export type WorkBuddyCliReasonCode = (typeof WORKBUDDY_CLI_REASON_CODES)[number]

/** Was this value one of the CLI's documented sign-out reason codes? */
export function isWorkBuddyCliReasonCode(value: unknown): value is WorkBuddyCliReasonCode {
  return typeof value === 'string' && (WORKBUDDY_CLI_REASON_CODES as readonly string[]).includes(value)
}

/**
 * Translate a CLI reason code into this plugin's closed reason vocabulary.
 *
 * Credential causes map onto the credential codes; every Electron discovery
 * failure is a local environment problem the operator cannot fix from inside
 * the doctor, so it becomes `internal_error` and the original code is kept in
 * the check's details instead of being lost.
 */
export function workBuddyReasonFor(code: string | undefined): ReasonCode {
  switch (code) {
    case 'no-credential':
      return REASON_CODES.credential_missing
    case 'credential-region-mismatch':
      return REASON_CODES.credential_region_mismatch
    case 'encrypted-credential-unreadable':
      return REASON_CODES.credential_unreadable
    default:
      return REASON_CODES.internal_error
  }
}

/** Was this one of the Electron-helper discovery codes? */
export function isWorkBuddyElectronReason(code: string | undefined): boolean {
  return typeof code === 'string' && code.startsWith('electron-')
}

/** One `doctor --json` document, reduced to the fields the doctor may show. */
export interface WorkBuddyDoctorJson {
  /** Package version the CLI reported. */
  pluginVersion: string | undefined
  /** `signed-in` | `signed-out` | `error`, verbatim. */
  signIn: string | undefined
  /** The closed-set sign-out cause, when one was reported. */
  reasonCode: string | undefined
  /** `absent` | `plaintext` | `encrypted` | `unrecognized`. */
  desktopAuthFormat: string | undefined
  /** Whether a desktop auth file was located. */
  desktopAuthPresent: boolean | undefined
  /** Whether a host heartbeat record exists. */
  hostHeartbeatPresent: boolean | undefined
  /** Whether the host process named by that record is alive. */
  hostHeartbeatProcessAlive: boolean | undefined
  /** Size of the compiled-in fallback roster. */
  fallbackModels: number | undefined
}

/** One `doctor --share` document, reduced to its fixed-vocabulary fields. */
export interface WorkBuddyShareJson {
  /** Package version the CLI reported. */
  pluginVersion: string | undefined
  /** `signed-in` | `signed-out`. */
  signIn: string | undefined
  /** The closed-set sign-out cause, when one was reported. */
  reasonCode: string | undefined
  /** `diagnostic-unavailable` when the CLI could not finish reading local state. */
  errorCode: string | undefined
  /** The three-state readiness block. */
  readiness:
    | {
        authentication: string | undefined
        host: string | undefined
        liveInference: string | undefined
      }
    | undefined
  /** Whether a desktop auth file was located. */
  desktopAuthPresent: boolean | undefined
  /** `absent` | `plaintext` | `encrypted` | `unrecognized`. */
  desktopAuthFormat: string | undefined
  /** Whether a host heartbeat record exists. */
  hostHeartbeatPresent: boolean | undefined
  /** Whether the host process named by that record is alive. */
  hostHeartbeatProcessAlive: boolean | undefined
  /** Size of the compiled-in fallback roster. */
  fallbackModels: number | undefined
}

/** Read one plain record, or nothing when the value is not an object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read one string field. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read one boolean field. */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Read one finite number field. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Find the end of the JSON object that starts at `start`.
 *
 * Brace counting has to ignore braces inside string literals, otherwise a
 * Windows path or a model name that contains `}` would truncate the scan. The
 * CLI may print human-readable lines before the document, which is why the
 * caller searches for the first `{` instead of parsing the whole stdout.
 */
function scanObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Extract the first complete JSON object from text that may carry a preamble.
 *
 * The CLI prints its document on one line today, but a future version (or a
 * Node warning on stderr merged into stdout by a shell) must not make the whole
 * check fail: a candidate that does not parse is skipped and the scan resumes
 * at the next `{`.
 *
 * @param text - Whatever the CLI wrote to stdout.
 * @returns The parsed object, or `undefined` when no object could be parsed.
 */
export function extractJsonObject(text: string): unknown {
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom)
    if (start < 0) return undefined
    const end = scanObjectEnd(text, start)
    if (end >= 0) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown
      } catch {
        // Not the document; keep looking for a later candidate.
      }
    }
    searchFrom = start + 1
  }
  return undefined
}

/**
 * Reduce a parsed `doctor --json` document to the whitelisted fields.
 *
 * `desktopAuthFile.path`, `ownAuthFile`, `hostHeartbeat.path` and
 * `hostHeartbeat.pid` are deliberately not read: the adapter must not be able
 * to copy them into a report even by accident.
 */
export function readDoctorJson(value: unknown): WorkBuddyDoctorJson | undefined {
  const root = asRecord(value)
  if (root === undefined) return undefined
  const desktopAuthFile = asRecord(root['desktopAuthFile'])
  const hostHeartbeat = asRecord(root['hostHeartbeat'])
  const result: WorkBuddyDoctorJson = {
    pluginVersion: asString(root['version']),
    signIn: asString(root['signIn']),
    reasonCode: asString(root['reasonCode']),
    desktopAuthFormat: asString(desktopAuthFile?.['format']),
    desktopAuthPresent: asBoolean(desktopAuthFile?.['present']),
    hostHeartbeatPresent: asBoolean(hostHeartbeat?.['present']),
    hostHeartbeatProcessAlive: asBoolean(hostHeartbeat?.['processAlive']),
    fallbackModels: asNumber(root['fallbackModels']),
  }
  // A document without a provider is not one of ours; treat it as unparseable
  // rather than reporting sign-in state read from another product's report.
  const provider = asString(root['provider'])
  if (provider !== undefined && provider !== 'workbuddy' && provider !== 'workbuddy-ai') return undefined
  return result
}

/** Reduce a parsed `doctor --share` document to its fixed-vocabulary fields. */
export function readShareJson(value: unknown): WorkBuddyShareJson | undefined {
  const root = asRecord(value)
  if (root === undefined) return undefined
  const readiness = asRecord(root['readiness'])
  const desktopAuthFile = asRecord(root['desktopAuthFile'])
  const hostHeartbeat = asRecord(root['hostHeartbeat'])
  const result: WorkBuddyShareJson = {
    pluginVersion: asString(root['version']),
    signIn: asString(root['signIn']),
    reasonCode: asString(root['reasonCode']),
    errorCode: asString(root['errorCode']),
    readiness:
      readiness === undefined
        ? undefined
        : {
            authentication: asString(readiness['authentication']),
            host: asString(readiness['host']),
            liveInference: asString(readiness['liveInference']),
          },
    desktopAuthPresent: asBoolean(desktopAuthFile?.['present']),
    desktopAuthFormat: asString(desktopAuthFile?.['format']),
    hostHeartbeatPresent: asBoolean(hostHeartbeat?.['present']),
    hostHeartbeatProcessAlive: asBoolean(hostHeartbeat?.['processAlive']),
    fallbackModels: asNumber(root['fallbackModels']),
  }
  const provider = asString(root['provider'])
  if (provider !== undefined && provider !== 'workbuddy' && provider !== 'workbuddy-ai') return undefined
  return result
}

/**
 * Locate the installed CLI entry script, without consulting `PATH`.
 *
 * The host process must run `process.execPath <bin.js>` rather than the shim on
 * `PATH`: on Windows the bin is a `.cmd` shim, and a shim resolved from a
 * different Node install would run the CLI under a runtime the plugin never
 * verified. Resolution walks the anchors the host actually knows about — the
 * running profile first, then the DSH home — and reads the package's own
 * manifest for the `bin` entry so a pnpm store layout resolves the same way as
 * a hoisted one.
 *
 * @param context - The bits of {@link AdapterContext} that name locations.
 * @returns The absolute path of the CLI's ESM entry, or `undefined`.
 */
export function resolveWorkBuddyCli(context: Pick<AdapterContext, 'dshHome' | 'profileDir'>): string | undefined {
  const anchors: string[] = []
  if (context.profileDir !== undefined) anchors.push(context.profileDir)
  anchors.push(context.dshHome)
  for (const anchor of anchors) {
    const resolved = resolveFromAnchor(anchor)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

/** Try one anchor directory: package resolution first, then the literal layout. */
function resolveFromAnchor(anchor: string): string | undefined {
  const viaManifest = resolveViaManifest(anchor)
  if (viaManifest !== undefined) return viaManifest
  // A profile whose node_modules is not resolvable from the anchor (a
  // symlinked home, a junction) still has the documented layout; this is the
  // same evidence the package manager writes, just without `exports` parsing.
  const literal = path.join(anchor, 'node_modules', WORKBUDDY_PACKAGE, 'lib', 'bin.js')
  return existsSync(literal) ? literal : undefined
}

/** Resolve the package manifest through Node's own resolver. */
function resolveViaManifest(anchor: string): string | undefined {
  try {
    const require = createRequire(path.join(anchor, 'package.json'))
    const manifestPath = require.resolve(`${WORKBUDDY_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    const root = asRecord(manifest)
    if (root === undefined) return undefined
    const bin = root['bin']
    const relative =
      typeof bin === 'string'
        ? bin
        : asRecord(bin) === undefined
          ? undefined
          : asString((bin as Record<string, unknown>)[WORKBUDDY_CLI_BIN])
    if (relative === undefined) return undefined
    const absolute = path.resolve(path.dirname(manifestPath), relative)
    return existsSync(absolute) ? absolute : undefined
  } catch {
    // Not installed here, or the manifest is unreadable: the caller tries the
    // next anchor. Resolution never throws — a missing CLI is a reportable
    // state, not a crash.
    return undefined
  }
}

/** What the profile's own dependency records say about the package. */
export interface ProfileManifestFacts {
  /** The manifest was read and at least one dependency section exists. */
  readable: boolean
  /** The package appears in `dependencies` or `devDependencies`. */
  declared: boolean
  /**
   * A directory for the package exists under `<profileDir>/node_modules`.
   *
   * Evidence for the details panel only: a directory without a dependency
   * record is a leftover, not an installation.
   */
  nodeModulesPresent: boolean
}

/**
 * Read the profile's dependency records as a plain name-to-range map.
 *
 * The install check decides from this map alone: a directory under
 * `node_modules` is not evidence of an install (a leftover survives an
 * uninstall), so it is only ever reported beside the verdict, never used to
 * reach it. A profile with no readable manifest yields `undefined`, which the
 * check reports as "inventory unavailable" rather than "not installed".
 *
 * @param profileDir - The running profile's directory, when known.
 * @returns The merged `dependencies` and `devDependencies`, or `undefined`.
 */
export function readProfileDependencies(profileDir: string | undefined): Record<string, string> | undefined {
  if (profileDir === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as unknown
  } catch {
    return undefined
  }
  const root = asRecord(parsed)
  if (root === undefined) return undefined
  const dependencies = asRecord(root['dependencies'])
  const devDependencies = asRecord(root['devDependencies'])
  if (dependencies === undefined && devDependencies === undefined) return undefined
  const merged: Record<string, string> = {}
  for (const section of [dependencies, devDependencies]) {
    if (section === undefined) continue
    for (const [name, version] of Object.entries(section)) {
      if (typeof version === 'string') merged[name] = version
    }
  }
  return merged
}

/** Inspect one profile directory's dependency records. */
export function inspectProfileManifest(profileDir: string | undefined): ProfileManifestFacts {
  if (profileDir === undefined) return { readable: false, declared: false, nodeModulesPresent: false }
  const nodeModulesPresent = existsSync(path.join(profileDir, 'node_modules', WORKBUDDY_PACKAGE))
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as unknown
  } catch {
    return { readable: false, declared: false, nodeModulesPresent }
  }
  const root = asRecord(parsed)
  if (root === undefined) return { readable: false, declared: false, nodeModulesPresent }
  const dependencies = asRecord(root['dependencies'])
  const devDependencies = asRecord(root['devDependencies'])
  if (dependencies === undefined && devDependencies === undefined) {
    return { readable: false, declared: false, nodeModulesPresent }
  }
  const declared = dependencies?.[WORKBUDDY_PACKAGE] !== undefined || devDependencies?.[WORKBUDDY_PACKAGE] !== undefined
  return { readable: true, declared, nodeModulesPresent }
}
