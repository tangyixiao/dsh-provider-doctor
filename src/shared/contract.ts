/**
 * The result contract shared by the Host half, the browser half and the
 * standalone report. Every field here is a closed vocabulary: a value outside
 * these unions is a bug in the producing check, never something the UI has to
 * interpret.
 *
 * The contract deliberately separates "what was seen" ({@link EvidenceKind})
 * from "what it means" ({@link CheckStatus}). A provider that was never looked
 * at is `not_checked`, never `fail`; a lookup that ran out of time is
 * `timeout`, never "signed out".
 *
 * @module dsh-provider-doctor/shared/contract
 */

/** The providers this first version diagnoses. */
export type ProviderId = 'workbuddy' | 'workbuddy-ai' | 'zcode-cli'

/** Every provider id, in the order the UI lists them. */
export const PROVIDER_IDS: readonly ProviderId[] = ['workbuddy', 'workbuddy-ai', 'zcode-cli']

/** Where a piece of evidence came from. */
export type EvidenceSource =
  /** A live DSH service in this process (`llm`, `pluginInventory`, `loader`). */
  | 'live_host'
  /** The provider plugin's own documented diagnostic entry point. */
  | 'provider_diagnostic'
  /** Local files: manifests, profiles, metadata. Read-only, no network. */
  | 'local_metadata'
  /** Whatever the person running the check told us. */
  | 'user_supplied'
  /** A built-in default used when nothing else could be observed. */
  | 'fallback'

/** How strong the evidence behind one check is. */
export type EvidenceKind =
  /** The datum was read from the authoritative interface during this run. */
  | 'observed'
  /** The datum follows from other observations but was not read directly. */
  | 'inferred'
  /** No datum could be obtained; the status explains why. */
  | 'unavailable'

/** The verdict of one check. */
export type CheckStatus =
  /** The link is present and behaves as the contract requires. */
  | 'pass'
  /** The link is definitively absent or definitively refused. */
  | 'fail'
  /** Present, but degraded, partial, or needing operator attention. */
  | 'warning'
  /** Evidence was not obtainable. Never rendered as a pass or a failure. */
  | 'unknown'
  /** Deliberately skipped (a side-effecting check that was not requested). */
  | 'not_checked'
  /** The check ran out of its own time budget. */
  | 'timeout'
  /** The person cancelled the run. */
  | 'cancelled'

/** One check the doctor can report on, in chain order. */
export type CheckId =
  | 'host-runtime'
  | 'profile-identity'
  | 'plugin-installed'
  | 'plugin-enabled'
  | 'provider-registered'
  | 'provider-configurable'
  | 'credential-metadata'
  | 'model-catalog'
  | 'provider-diagnostic'
  | 'recent-error'

/** How a check's cost is classified, so the UI can disclose it before running. */
export type CheckCost =
  /** Local reads only: no network, no child process. */
  | 'offline'
  /** May start a local process and/or use a signed-in session over the network. */
  | 'side_effecting'

/** One observed link in the provider chain. */
export interface CheckResult {
  /** Stable identifier; unique within one report. */
  id: CheckId
  /** The verdict. */
  status: CheckStatus
  /** How strong the evidence is. */
  evidenceKind: EvidenceKind
  /** When the evidence was collected, as an ISO-8601 instant. */
  observedAt: string
  /** Which interface produced it. */
  source: EvidenceSource
  /** What this check costs, so the UI can disclose it. */
  cost: CheckCost
  /** A fixed, translatable reason code; absent when the check passed cleanly. */
  reasonCode?: string
  /** One line of human-readable evidence, already redacted. */
  summary: string
  /** Concrete next steps for the operator; empty when nothing is wrong. */
  nextSteps: string[]
  /** Structured, redacted detail for the expandable panel. */
  details?: Readonly<Record<string, unknown>>
}

/** One provider's report. */
export interface DiagnosticReport {
  /** Contract version of this document. */
  schemaVersion: 1
  /** The provider the checks describe. */
  provider: ProviderId
  /** The plugin that owns the provider route, as installed. */
  plugin: { name: string; version?: string }
  /** Which DSH home/profile the evidence came from. */
  profile: { kind: 'live_host' | 'isolated'; identity: string }
  /** The host build the report was produced on. */
  host: { dshVersion?: string; nodeVersion: string; platform: string; arch: string }
  /** Every check, in chain order. */
  checks: CheckResult[]
  /** When the whole report was assembled, as an ISO-8601 instant. */
  observedAt: string
}

/** A redacted report suitable for pasting into an issue. */
export interface ShareableReport {
  schemaVersion: 1
  package: 'dsh-provider-doctor'
  version: string
  runtime: string
  platform: string
  architecture: string
  reports: ShareableReportEntry[]
}

/** One provider inside {@link ShareableReport}: only fixed-vocabulary fields. */
export interface ShareableReportEntry {
  provider: ProviderId
  readiness: {
    installed: 'installed' | 'missing' | 'unknown'
    enabled: 'enabled' | 'disabled' | 'unknown'
    registration: 'registered' | 'missing' | 'unknown'
    catalog: 'readable' | 'unreadable' | 'not-tested' | 'unknown'
    liveInference: 'not-tested'
  }
  checks: {
    id: CheckId
    status: CheckStatus
    evidenceKind: EvidenceKind
    source: EvidenceSource
    reasonCode?: string
  }[]
}

/** Does this status mean the link works? */
export function isHealthy(status: CheckStatus): boolean {
  return status === 'pass'
}

/** Does this status mean the link is definitively broken? */
export function isBroken(status: CheckStatus): boolean {
  return status === 'fail' || status === 'warning'
}

/** Did the check not run at all (as opposed to running and finding nothing)? */
export function isUnresolved(status: CheckStatus): boolean {
  return status === 'unknown' || status === 'not_checked' || status === 'timeout' || status === 'cancelled'
}
