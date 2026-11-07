/**
 * Constructors and guards for {@link CheckResult} values.
 *
 * Every adapter builds its results through these helpers rather than object
 * literals, so the invariants the UI relies on hold by construction:
 *
 * - `observedAt` is always a real ISO instant;
 * - a non-passing check always carries exactly one known reason code;
 * - a passing check never carries one;
 * - `nextSteps` is present but empty unless the operator must act;
 * - details are redacted before they leave the producing function.
 *
 * @module dsh-provider-doctor/shared/check-helpers
 */

import type { CheckCost, CheckId, CheckResult, CheckStatus, EvidenceKind, EvidenceSource } from './contract.ts'
import { isReasonCode, type ReasonCode } from './reason-codes.ts'
import { redactText, redactValue } from '../privacy/redact.ts'

/** The arguments one check needs beyond its verdict. */
export interface CheckInput {
  id: CheckId
  status: CheckStatus
  evidenceKind: EvidenceKind
  source: EvidenceSource
  cost?: CheckCost
  reasonCode?: ReasonCode
  summary: string
  nextSteps?: string[]
  details?: Record<string, unknown>
  /** Override the observation instant (tests pin it). */
  observedAt?: string
}

/**
 * Build one check result, enforcing the contract's invariants.
 *
 * A passing check never keeps a reason code: "why it did not work" is
 * meaningless on a link that worked, and a shareable report that carried one
 * would invite a reader to look for a fault that is not there. Every other
 * status without a recognised code falls back to `internal_error` rather than
 * producing a report the UI cannot explain.
 *
 * @param input - The check's verdict and its evidence.
 * @returns A complete, redacted {@link CheckResult}.
 */
export function makeCheck(input: CheckInput): CheckResult {
  const reasonCode = normaliseReasonCode(input.status, input.reasonCode)
  const result: CheckResult = {
    id: input.id,
    status: input.status,
    evidenceKind: input.evidenceKind,
    observedAt: input.observedAt ?? new Date().toISOString(),
    source: input.source,
    cost: input.cost ?? 'offline',
    summary: redactText(input.summary),
    nextSteps: (input.nextSteps ?? []).map(redactText),
  }
  if (reasonCode !== undefined) result.reasonCode = reasonCode
  if (input.details !== undefined) result.details = redactValue(input.details) as Record<string, unknown>
  return result
}

/** Keep a code when it is known; invent `internal_error` when a failure lacks one. */
function normaliseReasonCode(status: CheckStatus, code: string | undefined): string | undefined {
  if (status === 'pass') return undefined
  if (code !== undefined && isReasonCode(code)) return code
  return 'internal_error'
}

/** A check that ran and found the link present. */
export function pass(input: Omit<CheckInput, 'status'>): CheckResult {
  return makeCheck({ ...input, status: 'pass' })
}

/** A check that ran and found the link definitively broken. */
export function fail(input: Omit<CheckInput, 'status'> & { reasonCode: ReasonCode }): CheckResult {
  return makeCheck({ ...input, status: 'fail' })
}

/** A check that ran and found the link present but degraded. */
export function warn(input: Omit<CheckInput, 'status'> & { reasonCode: ReasonCode }): CheckResult {
  return makeCheck({ ...input, status: 'warning' })
}

/** A check whose evidence could not be obtained. */
export function unknown(input: Omit<CheckInput, 'status'> & { reasonCode: ReasonCode }): CheckResult {
  return makeCheck({ ...input, status: 'unknown' })
}

/** A side-effecting check the operator did not request. */
export function notChecked(input: Omit<CheckInput, 'status'> & { reasonCode?: ReasonCode }): CheckResult {
  return makeCheck({ ...input, status: 'not_checked', reasonCode: input.reasonCode ?? 'not_requested' })
}

/** A check that exceeded its budget. Never downgraded into a failure. */
export function timedOut(input: Omit<CheckInput, 'status'>): CheckResult {
  return makeCheck({ ...input, status: 'timeout', reasonCode: 'timed_out' })
}

/** A check interrupted by cancellation. */
export function cancelled(input: Omit<CheckInput, 'status'>): CheckResult {
  return makeCheck({ ...input, status: 'cancelled', reasonCode: 'cancelled' })
}

/** The outcome of running one bounded probe. */
export type ProbeOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown }

/**
 * Run one promise under a budget and a cancellation signal.
 *
 * The race is settled exactly once, so a slow probe that resolves after the
 * budget elapsed cannot overwrite the timeout verdict. The probe itself is not
 * cancelled through this helper — callers that start a process own its
 * disposal and must pass the same signal down.
 *
 * Cancellation settles the race immediately rather than waiting for the probe:
 * a hung child process would otherwise hold the run open until its own budget
 * expired, which is exactly the moment the operator asked to stop.
 *
 * @param run - The probe; receives the signal it should honour.
 * @param options - Budget and the outer cancellation signal.
 * @returns How the probe settled.
 */
export async function probeWithBudget<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { budgetMs: number; signal: AbortSignal },
): Promise<ProbeOutcome<T>> {
  if (options.signal.aborted) return { kind: 'cancelled' }
  const controller = new AbortController()
  let stopped = false
  let settled = false
  let resolveOutcome: (outcome: ProbeOutcome<T>) => void = () => {}
  const settle = (outcome: ProbeOutcome<T>): void => {
    if (settled) return
    settled = true
    resolveOutcome(outcome)
  }
  const forwardAbort = (): void => {
    stopped = true
    controller.abort()
    settle({ kind: 'cancelled' })
  }
  options.signal.addEventListener('abort', forwardAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raced = new Promise<ProbeOutcome<T>>((resolve) => {
      resolveOutcome = resolve
    })
    timer = setTimeout(() => {
      controller.abort()
      settle({ kind: 'timeout' })
    }, options.budgetMs)
    // The probe's own result only wins while nobody has asked to stop.
    void run(controller.signal).then(
      (value) => {
        if (!stopped) settle({ kind: 'value', value })
      },
      (error: unknown) => {
        if (!stopped) settle({ kind: 'error', error })
      },
    )
    return await raced
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal.removeEventListener('abort', forwardAbort)
  }
}

/** A one-line description of an unknown thrown value, safe to display. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
