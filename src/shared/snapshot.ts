/**
 * The snapshot the Host half produces and the browser half renders.
 *
 * The type lives in `shared/` rather than beside the service that builds it
 * because the two halves are separate bundles: the Host half is ESM in the
 * Electron main process, the browser half is a CommonJS factory in the
 * renderer. A type import across that boundary is free; a value import would
 * drag `node:fs` into the browser bundle. Declaring the shape here — with no
 * imports of its own — is what keeps that boundary honest.
 *
 * @module dsh-provider-doctor/shared/snapshot
 */

import type { CheckResult, CheckStatus, DiagnosticReport, EvidenceKind } from './contract.ts'
import { isBroken, isHealthy, isUnresolved } from './contract.ts'

/** The host facts as they cross the wire. Mirrors `HostFacts` structurally. */
export interface HostFactsView {
  /** The authoritative DSH build, when it could be read. Never a placeholder. */
  dshVersion?: string
  /** Which source produced {@link dshVersion}. */
  dshVersionSource: 'injected' | 'package-manifest' | 'unavailable'
  /** `process.version` of the Host process. */
  nodeVersion: string
  /** `process.platform` of the Host process. */
  platform: string
  /** `process.arch` of the Host process. */
  arch: string
  /** Absolute DSH home the run reads from. Shown only behind a disclosure. */
  dshHome: string
}

/** A provider plugin's install state. */
export interface PluginFactsView {
  name: string
  version?: string
}

/** The profile facts as they cross the wire. Mirrors `ProfileFacts` structurally. */
export interface ProfileFactsView {
  /** The profile *name* only. */
  name?: string
  /** Absolute profile directory. Shown only behind a disclosure. */
  dir?: string
  /** Every candidate profile name that was visible. */
  candidates: readonly string[]
  /** How the name was located. */
  source: string
  /** Whether the name was read directly, inferred, or is unavailable. */
  evidence: EvidenceKind
}

/** One adapter-level failure: the provider could not be diagnosed at all. */
export interface ProviderFailure {
  provider: string
  message: string
}

/** Everything one run produced. */
export interface DoctorSnapshot {
  /** When the snapshot was assembled, as an ISO-8601 instant. */
  observedAt: string
  /** Which host build produced it. */
  host: HostFactsView
  /** Which profile the evidence came from. */
  profile: ProfileFactsView
  /** One report per provider, in adapter order. */
  reports: DiagnosticReport[]
  /** Providers whose adapter failed before producing evidence. */
  failures: ProviderFailure[]
  /** Whether this run included the side-effecting connection check. */
  connectionCheck: boolean
  /** Whether a run is in flight right now. */
  running: boolean
}

/** The `status` route's shape: either a snapshot or an explicit empty state. */
export type StatusResponse =
  | { schemaVersion: 1; empty: true; running: boolean }
  | ({ schemaVersion: 1; empty: false } & DoctorSnapshot)

/** The one-line verdict for a whole provider report. */
export type ReportVerdict = 'healthy' | 'broken' | 'unresolved' | 'running'

/**
 * Reduce a provider report to the single word the summary line shows.
 *
 * The order matters: one definitively broken link outranks any number of
 * passing ones, and one link that could not be observed outranks "healthy" —
 * so a report is only `healthy` when every check actually passed. A check that
 * was deliberately skipped (`not_checked`) therefore keeps a report out of
 * `healthy`, which is the honest reading: the doctor did not see that link.
 *
 * @param checks - The report's checks, in chain order.
 * @returns The verdict the summary line uses.
 */
export function verdictOf(checks: readonly CheckResult[]): ReportVerdict {
  if (checks.length === 0) return 'unresolved'
  if (checks.some((check) => isBroken(check.status))) return 'broken'
  if (checks.some((check) => isUnresolved(check.status))) return 'unresolved'
  if (checks.every((check) => isHealthy(check.status))) return 'healthy'
  return 'unresolved'
}

/** The status that decides the dot on one provider tab. */
export function worstStatus(checks: readonly CheckResult[]): CheckStatus | undefined {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'warning')) return 'warning'
  if (checks.some((check) => check.status === 'timeout')) return 'timeout'
  if (checks.some((check) => check.status === 'cancelled')) return 'cancelled'
  if (checks.some((check) => check.status === 'unknown')) return 'unknown'
  if (checks.some((check) => check.status === 'not_checked')) return 'not_checked'
  if (checks.length > 0) return 'pass'
  return undefined
}

/** How many checks of each verdict a report contains, for the tab subtitle. */
export function countBySeverity(checks: readonly CheckResult[]): {
  pass: number
  fail: number
  warning: number
  unresolved: number
} {
  let pass = 0
  let fail = 0
  let warning = 0
  let unresolved = 0
  for (const check of checks) {
    if (check.status === 'pass') pass += 1
    else if (check.status === 'fail') fail += 1
    else if (check.status === 'warning') warning += 1
    else unresolved += 1
  }
  return { pass, fail, warning, unresolved }
}
