/**
 * The `recent-error` link: what the last request to this provider said.
 *
 * This is the least authoritative check in the chain, and the design reflects
 * that. DSH does not expose a "last provider error" service, so the only
 * structured evidence available locally is the provider plugin's own probe store
 * — a small JSON record of the last reasoning-effort validation per account and
 * model. When that file is absent or unreadable the honest answer is `unknown`,
 * not "no errors": a doctor that reports clean because it could not look is
 * worse than one that admits it.
 *
 * Everything read here is reduced to a closed set of words before it reaches a
 * report: a validation verdict, a timestamp turned into a coarse age, and a
 * count of entries. The probe store also holds account identifiers; those are
 * never touched, only the inner model records are read.
 *
 * @module dsh-provider-doctor/providers/recent-error
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { CheckResult } from '../shared/contract.ts'
import { pass, unknown, warn } from '../shared/check-helpers.ts'
import { REASON_CODES } from '../shared/reason-codes.ts'
import { redactText } from '../privacy/redact.ts'

/** How one recorded probe looked, reduced to what a report may carry. */
interface ProbeRecord {
  /** `validating` | `non-validating` | `unknown`, verbatim from the store. */
  validation: string
  /** Epoch milliseconds of the last attempt, when readable. */
  probedAtMs: number | undefined
  /** Plugin version that wrote the record. */
  pluginVersion: string | undefined
}

/** The result of reading one provider's probe store. */
type ProbeReading =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'records'; records: ProbeRecord[] }

/** The probe store file name per provider. ZCode keeps no such record. */
const PROBE_FILES = {
  workbuddy: '.workbuddy-probe.json',
  'workbuddy-ai': '.workbuddy-ai-probe.json',
} as const

/** The providers whose last-request evidence this module can read. */
export type ProbeProviderId = keyof typeof PROBE_FILES

/** Is this provider one whose probe store exists? */
export function hasProbeStore(provider: string): provider is ProbeProviderId {
  return Object.prototype.hasOwnProperty.call(PROBE_FILES, provider)
}

/**
 * Read one provider's probe store without trusting its shape.
 *
 * @param dshHome - Absolute `.dsh` directory.
 * @param provider - Which store to read.
 * @returns The parsed records, an explicit absence, or "unreadable".
 */
function readProbeStore(dshHome: string, provider: ProbeProviderId): ProbeReading {
  let text: string
  try {
    text = readFileSync(path.join(dshHome, PROBE_FILES[provider]), 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable' }

  const recordsNode = (parsed as Record<string, unknown>)['records']
  if (typeof recordsNode !== 'object' || recordsNode === null) return { kind: 'records', records: [] }

  const records: ProbeRecord[] = []
  for (const accountValue of Object.values(recordsNode as Record<string, unknown>)) {
    if (typeof accountValue !== 'object' || accountValue === null) continue
    for (const modelValue of Object.values(accountValue as Record<string, unknown>)) {
      if (typeof modelValue !== 'object' || modelValue === null) continue
      const entry = modelValue as Record<string, unknown>
      const validation = entry['validation']
      if (typeof validation !== 'string') continue
      const probedAt = entry['probedAtMs']
      const pluginVersion = entry['pluginVersion']
      records.push({
        validation,
        probedAtMs: typeof probedAt === 'number' && Number.isFinite(probedAt) ? probedAt : undefined,
        pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      })
    }
  }
  return { kind: 'records', records }
}

/** Render an elapsed time as a coarse, localization-free duration. */
function describeAge(probedAtMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - probedAtMs) / 1000))
  if (seconds < 90) return 'less than two minutes ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `about ${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `about ${hours} hours ago`
  return `about ${Math.round(hours / 24)} days ago`
}

/**
 * Summarize a provider's recorded request outcomes into one check.
 *
 * Three outcomes matter to an operator: a validation ran and the model accepts
 * the requested reasoning effort (`validating`), it ran and the model does not
 * (`non-validating`), or it ran and decided nothing (`unknown`, the normal state
 * for a model that was never actually tried). Only the second is a warning; a
 * store that does not exist is `unknown` rather than a pass.
 *
 * @param input - Where the store lives, which provider to read, and the clock.
 * @returns The `recent-error` check for this provider.
 */
export function recentErrorCheck(input: {
  dshHome: string
  provider: ProbeProviderId
  now?: number
}): CheckResult {
  const reading = readProbeStore(input.dshHome, input.provider)

  if (reading.kind === 'absent') {
    return unknown({
      id: 'recent-error',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: REASON_CODES.no_recorded_attempt,
      summary: 'No request outcome has been recorded for this provider yet.',
      nextSteps: ['Send one message through a model from this provider; the outcome is then recorded here.'],
      details: { probeStore: 'absent' },
    })
  }

  if (reading.kind === 'unreadable') {
    return unknown({
      id: 'recent-error',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: REASON_CODES.probe_store_unreadable,
      summary: 'The recorded request outcome exists but could not be read.',
      nextSteps: ['Send one message through this provider, then diagnose again.'],
      details: { probeStore: 'unreadable' },
    })
  }

  if (reading.records.length === 0) {
    return unknown({
      id: 'recent-error',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: REASON_CODES.no_recorded_attempt,
      summary: 'The request-outcome record exists but holds no entries.',
      nextSteps: ['Send one message through this provider, then diagnose again.'],
      details: { probeStore: 'empty' },
    })
  }

  const now = input.now ?? Date.now()
  const newest = reading.records.reduce<ProbeRecord | undefined>((best, record) => {
    if (record.probedAtMs === undefined) return best
    if (best?.probedAtMs === undefined) return record
    return record.probedAtMs > best.probedAtMs ? record : best
  }, undefined)

  // A record without a timestamp still states what happened, it just cannot be
  // dated. Fall back to the last record written so that a store from a version
  // that stopped stamping attempts does not degrade into "no conclusion" —
  // while leaving the age out, because inventing one would be worse.
  const latest = newest ?? reading.records[reading.records.length - 1]
  const validation = latest?.validation ?? 'unknown'
  const age = newest?.probedAtMs === undefined ? undefined : describeAge(newest.probedAtMs, now)
  const when = age === undefined ? '' : `, ${age},`
  const details: Record<string, unknown> = {
    probeStore: 'readable',
    entries: reading.records.length,
    lastValidation: redactText(validation),
  }
  if (age !== undefined) details['lastAttempt'] = age
  if (newest?.pluginVersion !== undefined) details['recordedByVersion'] = redactText(newest.pluginVersion)
  else if (latest?.pluginVersion !== undefined) details['recordedByVersion'] = redactText(latest.pluginVersion)

  if (validation === 'non-validating') {
    return warn({
      id: 'recent-error',
      evidenceKind: 'observed',
      source: 'local_metadata',
      reasonCode: REASON_CODES.model_rejected_reasoning,
      summary: `The last recorded attempt${when} did not accept this model's reasoning settings.`,
      nextSteps: ['Lower the reasoning effort for this model, or choose a model that accepts it.'],
      details,
    })
  }

  if (validation === 'validating') {
    return pass({
      id: 'recent-error',
      evidenceKind: 'observed',
      source: 'local_metadata',
      summary: `The last recorded attempt${when} accepted this model's reasoning settings.`,
      details,
    })
  }

  return unknown({
    id: 'recent-error',
    evidenceKind: 'inferred',
    source: 'local_metadata',
    reasonCode: REASON_CODES.inconclusive_probe,
    summary: `The last recorded attempt${when} reached no conclusion about this model.`,
    nextSteps: ['Send one message through this model, then diagnose again to get a definite outcome.'],
    details,
  })
}
