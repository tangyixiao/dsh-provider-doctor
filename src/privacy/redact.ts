/**
 * Redaction for everything that leaves the Host half.
 *
 * Two different obligations live here:
 *
 * 1. {@link redactText} — free text (an error message, a plugin diagnostic)
 *    must lose credentials, absolute paths, and query strings before it is
 *    shown or shared. It is a best-effort filter applied at the boundary, not a
 *    substitute for not collecting secrets in the first place.
 * 2. {@link toShareableReport} — the shareable document is built from a fixed
 *    whitelist, so a field that was never added cannot leak. Free text does not
 *    cross this boundary at all.
 *
 * @module dsh-provider-doctor/privacy/redact
 */

import type {
  CheckId,
  CheckResult,
  CheckStatus,
  DiagnosticReport,
  EvidenceKind,
  EvidenceSource,
  ProviderId,
  ShareableReport,
  ShareableReportEntry,
} from '../shared/contract.ts'
import { isReasonCode } from '../shared/reason-codes.ts'

/** Replacement text for anything withheld. */
export const REDACTED = '[redacted]'

/** Absolute POSIX paths, minus the leading slash so `file:///a/b` also matches. */
const POSIX_PATH = /(?:^|[\s("'`=:])(\/(?:[\w.@+-]+\/)+[\w.@+-]+)/g

/** Windows absolute paths, drive-letter or UNC. */
const WINDOWS_PATH = /(?:^|[\s("'`=:])([A-Za-z]:\\[^\s"'`]+|\\\\[\w.$-]+\\[^\s"'`]+)/g

/** Home-relative paths that would otherwise survive as plain text. */
const HOME_PATH = /(?:^|[\s("'`=:])(~\/[^\s"'`]+|~\\[^\s"'`]+)/g

/** JWTs, wherever they appear. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g

/** `sk-…`-style API keys and long opaque tokens after a key name. */
const API_KEY = /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/g

/** `name=value` pairs whose name says it carries a secret. */
const SECRET_PARAM =
  /(\b(?:code|token|refresh_token|access_token|id_token|api_key|apikey|apiKey|key|secret|password|passwd|auth|authorization|session|cookie|bearer)=)[^&\s"'`]+/gi

/** Query strings keep their shape but lose their values. */
const QUERY_VALUE = /([?&][\w.-]+=)[^&\s"'`]*/g

/** A bare `Bearer <token>` header value. */
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Account-looking identifiers an error message might quote. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/**
 * Strip credentials, paths and query values from one free-text string.
 *
 * The function is total: any input, including an empty string or one that is
 * already clean, returns a string. It never throws, because it runs on error
 * paths where a second failure would hide the first.
 *
 * @param input - Text that may contain secrets or machine-specific paths.
 * @returns The same text with every recognised sensitive span replaced.
 */
export function redactText(input: string): string {
  let out = input
  out = out.replace(JWT, REDACTED)
  out = out.replace(API_KEY, REDACTED)
  out = out.replace(BEARER, `$1 ${REDACTED}`)
  out = out.replace(SECRET_PARAM, `$1${REDACTED}`)
  out = out.replace(QUERY_VALUE, `$1${REDACTED}`)
  out = out.replace(WINDOWS_PATH, (match, path: string) => match.replace(path, REDACTED))
  out = out.replace(POSIX_PATH, (match, path: string) => match.replace(path, REDACTED))
  out = out.replace(HOME_PATH, (match, path: string) => match.replace(path, REDACTED))
  out = out.replace(EMAIL, REDACTED)
  // A single very long token-shaped run is almost always a credential.
  out = out.replace(/\b[A-Za-z0-9_-]{48,}\b/g, REDACTED)
  return out.length > 400 ? `${out.slice(0, 397)}...` : out
}

/**
 * Redact every string inside a detail object, recursively, without changing
 * its shape.
 *
 * Arrays keep their length and objects keep their keys: the operator reads the
 * same structure, only the sensitive spans are gone. Depth is capped so a
 * cyclic or adversarial value cannot hang the Host.
 *
 * @param value - Arbitrary JSON-ish value.
 * @param depth - Current recursion depth (internal).
 * @returns An equivalent value with every string redacted.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(key)] = redactValue(item, depth + 1)
    }
    return out
  }
  return REDACTED
}

/** The host facts a shareable report may carry. */
export interface ShareableHostFacts {
  /** This plugin's own version. */
  version: string
  /** Node runtime version, e.g. `v24.21.0`. */
  runtime: string
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  architecture: string
}

/** One provider's readiness, reduced to the three-state vocabulary. */
function readinessOf(report: DiagnosticReport): ShareableReportEntry['readiness'] {
  const byId = new Map<CheckId, CheckResult>()
  for (const check of report.checks) byId.set(check.id, check)

  const installedCheck = byId.get('plugin-installed')
  const enabledCheck = byId.get('plugin-enabled')
  const registeredCheck = byId.get('provider-registered')
  const catalogCheck = byId.get('model-catalog')

  return {
    installed: triState(installedCheck, 'pass', 'fail'),
    enabled: triState(enabledCheck, 'pass', 'fail'),
    registration: triState(registeredCheck, 'pass', 'fail'),
    catalog: catalogTriState(catalogCheck),
    // Fixed by construction: this plugin never generates a model reply.
    liveInference: 'not-tested',
  }
}

/** Map one check onto installed/enabled/registration style three-state facts. */
function triState(
  check: CheckResult | undefined,
  pass: string,
  fail: string,
): 'installed' | 'missing' | 'unknown' | 'enabled' | 'disabled' | 'registered' | 'missing' {
  if (check === undefined) return 'unknown' as never
  if (check.status === 'pass') return pass as never
  if (check.status === 'fail') return fail as never
  return 'unknown' as never
}

/** The catalog's own four-state fact; `not_checked` stays distinguishable. */
function catalogTriState(check: CheckResult | undefined): 'readable' | 'unreadable' | 'not-tested' | 'unknown' {
  if (check === undefined) return 'unknown'
  if (check.status === 'pass') return 'readable'
  if (check.status === 'fail') return 'unreadable'
  if (check.status === 'not_checked') return 'not-tested'
  return 'unknown'
}

/**
 * Build the shareable document.
 *
 * Only fixed-vocabulary facts cross: provider id, five readiness words, and
 * per-check status/evidence/source/reason code. Summaries, next steps, details,
 * paths, versions of the provider plugin, timestamps and profile identity are
 * all dropped — the point of this document is that it can be pasted into a
 * public issue without review.
 *
 * @param reports - The live reports to reduce.
 * @param host - This plugin's own version and the runtime facts.
 * @returns A whitelist-only document.
 */
export function toShareableReport(reports: readonly DiagnosticReport[], host: ShareableHostFacts): ShareableReport {
  return {
    schemaVersion: 1,
    package: 'dsh-provider-doctor',
    version: host.version,
    runtime: host.runtime,
    platform: host.platform,
    architecture: host.architecture,
    reports: reports.map((report) => ({
      provider: report.provider,
      readiness: readinessOf(report),
      checks: report.checks.map((check) => {
        const entry: ShareableReportEntry['checks'][number] = {
          id: check.id,
          status: check.status,
          evidenceKind: check.evidenceKind,
          source: check.source,
        }
        // Only known codes cross; an unexpected one is dropped rather than
        // published, because an unknown code is exactly the kind of field that
        // might have been built from a message.
        if (check.reasonCode !== undefined && isReasonCode(check.reasonCode)) {
          entry.reasonCode = check.reasonCode
        }
        return entry
      }),
    })),
  }
}

/** Render the shareable document as the text the copy button puts on the clipboard. */
export function formatShareableReport(report: ShareableReport): string {
  const lines: string[] = [
    `dsh-provider-doctor ${report.version} — ${report.platform}/${report.architecture}, ${report.runtime}`,
    '',
  ]
  for (const entry of report.reports) {
    lines.push(`${entry.provider}`)
    lines.push(`  installed=${entry.readiness.installed} enabled=${entry.readiness.enabled} registration=${entry.readiness.registration} catalog=${entry.readiness.catalog} liveInference=${entry.readiness.liveInference}`)
    for (const check of entry.checks) {
      const code = check.reasonCode === undefined ? '' : ` (${check.reasonCode})`
      lines.push(`  - ${check.id}: ${check.status}/${check.evidenceKind} via ${check.source}${code}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Re-export the check vocabulary for callers that only import from here. */
export type { CheckId, CheckStatus, EvidenceKind, EvidenceSource, ProviderId }
