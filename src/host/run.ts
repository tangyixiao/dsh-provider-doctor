/**
 * The provider-chain runner.
 *
 * One run = every adapter's checks, each bounded by its own budget, assembled
 * into a {@link DiagnosticReport} per provider. The runner owns three policies
 * the adapters are not allowed to decide:
 *
 * - **Isolation.** A throwing adapter, or one that never settles, degrades to a
 *   single `unknown` check for that provider. The other providers still report.
 * - **Chain ordering.** Checks always appear in chain order regardless of the
 *   order an adapter returned them, because the UI renders position as meaning.
 * - **Cancellation.** An aborted run ends as `cancelled`, never as a failure.
 *
 * @module dsh-provider-doctor/host/run
 */

import type { CheckId, CheckResult, DiagnosticReport } from '../shared/contract.ts'
import { CHAIN_ORDER } from '../shared/chain.ts'
import { CHECK_CATALOG } from '../shared/catalog.ts'
import { cancelled, describeError, makeCheck, probeWithBudget } from '../shared/check-helpers.ts'
import type { AdapterContext, HostServices, ProviderAdapter } from '../providers/types.ts'
import type { HostFacts, ProfileFacts } from './runtime.ts'
import { hostRuntimeCheck, profileIdentityCheck } from './host-checks.ts'
import { DSH_ENGINE_RANGE } from './engine-range.ts'
import { redactText } from '../privacy/redact.ts'

/** Everything one run needs. */
export interface RunInput {
  adapters: readonly ProviderAdapter[]
  host: HostServices
  hostFacts: HostFacts
  profile: ProfileFacts
  dshHome: string
  /** Which checks are requested. Absent means the offline default set. */
  options?: RunOptions
  /** Cancellation for the whole run. */
  signal: AbortSignal
}

/** Per-run knobs the client may override. */
export interface RunOptions {
  /** Run side-effecting checks (the provider connection check). Default false. */
  connectionCheck?: boolean
  /** Budget for one adapter's whole set. Default 8000 ms. */
  adapterBudgetMs?: number
  /** Budget for one individual probe inside an adapter. Default 5000 ms. */
  probeBudgetMs?: number
  /**
   * The DSH range to hold the host to. Defaults to this build's own
   * `engines.dsh`; tests pin it to exercise the mismatch branch.
   */
  engineRange?: string
}

/** The outcome of one run. */
export interface RunResult {
  reports: DiagnosticReport[]
  /** Adapters that could not produce a report at all, with a redacted reason. */
  failures: { provider: string; message: string }[]
}

/** Default per-adapter budget: long enough for one CLI start, short enough to cancel. */
const DEFAULT_ADAPTER_BUDGET_MS = 8000

/** Default per-probe budget inside an adapter. */
const DEFAULT_PROBE_BUDGET_MS = 5000

/**
 * Run every adapter and assemble the reports.
 *
 * Adapters run concurrently: they read independent evidence, and a slow CLI on
 * one provider must not delay another provider's report by its own budget.
 *
 * @param input - Adapters, services and the run's knobs.
 * @returns One report per adapter that settled, plus the failures.
 */
export async function runDiagnostics(input: RunInput): Promise<RunResult> {
  const adapterBudgetMs = input.options?.adapterBudgetMs ?? DEFAULT_ADAPTER_BUDGET_MS
  const probeBudgetMs = input.options?.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS
  const connectionCheck = input.options?.connectionCheck ?? false

  // The two host-level links are the same evidence for every provider, so they
  // are collected once and repeated in each report. Collecting them per adapter
  // would let two reports disagree about the build they were produced on.
  const hostChecks: CheckResult[] = [
    hostRuntimeCheck({ facts: input.hostFacts, declaredRange: input.options?.engineRange ?? DSH_ENGINE_RANGE }),
    profileIdentityCheck({ profile: input.profile }),
  ]

  const settled = await Promise.all(
    input.adapters.map((adapter) => runOne(
      adapter,
      {
        host: input.host,
        dshHome: input.dshHome,
        ...input.profile.dir === undefined ? {} : { profileDir: input.profile.dir },
        signal: input.signal,
        budgetMs: probeBudgetMs,
        connectionCheck,
      },
      adapterBudgetMs,
    )),
  )

  const reports: DiagnosticReport[] = []
  const failures: RunResult['failures'] = []
  for (const [index, outcome] of settled.entries()) {
    const adapter = input.adapters[index]
    if (adapter === undefined) continue
    if (outcome.kind === 'report') {
      reports.push(assembleReport(adapter, [...hostChecks, ...outcome.checks], input))
    } else if (outcome.kind === 'cancelled') {
      reports.push(assembleReport(adapter, [...hostChecks, cancelledCheck(adapter)], input))
    } else {
      // The message is shown in the panel, so it is redacted at the source: an
      // adapter can only fail by throwing whatever a child process or the
      // filesystem said, and neither is allowed to carry a path or a token into
      // the UI.
      failures.push({ provider: adapter.id, message: redactText(describeError(outcome.error)) })
      reports.push(assembleReport(adapter, [...hostChecks, unknownAdapterCheck(adapter)], input))
    }
  }

  return { reports, failures }
}

/** How one adapter settled. */
type AdapterOutcome =
  | { kind: 'report'; checks: CheckResult[] }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown }

/** Run one adapter under its budget, converting every failure into an outcome. */
async function runOne(
  adapter: ProviderAdapter,
  context: AdapterContext,
  budgetMs: number,
): Promise<AdapterOutcome> {
  const outcome = await probeWithBudget(
    async (signal) => adapter.diagnose({ ...context, signal }),
    { budgetMs, signal: context.signal },
  )
  if (outcome.kind === 'value') {
    return { kind: 'report', checks: orderChecks(adapter, outcome.value) }
  }
  if (outcome.kind === 'timeout') {
    return { kind: 'report', checks: orderChecks(adapter, timeoutAdapterChecks(adapter)) }
  }
  if (outcome.kind === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'error', error: outcome.error }
}

/**
 * Put an adapter's checks into chain order and drop duplicates.
 *
 * A check the adapter never produced is not invented here: the UI renders a gap
 * as "not reported", which is more honest than a fabricated status.
 */
function orderChecks(adapter: ProviderAdapter, checks: readonly CheckResult[]): CheckResult[] {
  const byId = new Map<CheckId, CheckResult>()
  for (const check of checks) if (!byId.has(check.id)) byId.set(check.id, check)
  const ordered: CheckResult[] = []
  for (const id of CHAIN_ORDER) {
    const found = byId.get(id)
    if (found !== undefined) ordered.push(found)
  }
  // Any check whose id is not in the shared chain order still appears, at the
  // end, rather than being silently dropped.
  for (const check of checks) if (!CHAIN_ORDER.includes(check.id) && byId.get(check.id) === check) ordered.push(check)
  void adapter
  return ordered
}

/** One `unknown` check standing in for an adapter that never produced anything. */
function unknownAdapterCheck(adapter: ProviderAdapter): CheckResult {
  return makeCheck({
    id: 'provider-diagnostic',
    status: 'unknown',
    evidenceKind: 'unavailable',
    source: 'fallback',
    reasonCode: 'internal_error',
    summary: `The ${adapter.displayName} adapter failed before it could report.`,
    nextSteps: ['Re-run the diagnosis, then check the DSH log for this plugin.'],
  })
}

/** One `cancelled` check standing in for an adapter the person stopped. */
function cancelledCheck(adapter: ProviderAdapter): CheckResult {
  return cancelled({
    id: 'provider-diagnostic',
    evidenceKind: 'unavailable',
    source: 'fallback',
    summary: `The ${adapter.displayName} diagnosis was cancelled.`,
  })
}

/** Every check an adapter promised, each reported as a timeout. */
function timeoutAdapterChecks(adapter: ProviderAdapter): CheckResult[] {
  return adapter.checks
    .filter((id): id is CheckId => id in CHECK_CATALOG)
    .map((id) => makeCheck({
      id,
      status: 'timeout',
      evidenceKind: 'unavailable',
      source: 'fallback',
      reasonCode: 'timed_out',
      summary: `The ${adapter.displayName} check did not finish within its budget.`,
      nextSteps: ['Re-run the diagnosis; a slow local CLI is the usual cause.'],
    }))
}

/** Assemble one provider's report from its ordered checks. */
function assembleReport(adapter: ProviderAdapter, checks: CheckResult[], input: RunInput): DiagnosticReport {
  return {
    schemaVersion: 1,
    provider: adapter.id,
    plugin: { name: adapter.pluginName },
    profile: {
      kind: 'live_host',
      identity: input.profile.name ?? 'unknown',
    },
    host: {
      ...input.hostFacts.dshVersion === undefined ? {} : { dshVersion: input.hostFacts.dshVersion },
      nodeVersion: input.hostFacts.nodeVersion,
      platform: input.hostFacts.platform,
      arch: input.hostFacts.arch,
    },
    checks,
    observedAt: new Date().toISOString(),
  }
}
