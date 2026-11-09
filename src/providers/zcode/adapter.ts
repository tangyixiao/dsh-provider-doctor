/**
 * The ZCode CLI adapter.
 *
 * ZCode differs from WorkBuddy in a way that shapes every check here: the
 * provider route is registered by a plugin that spawns a *resident* CLI process,
 * and the only way to learn whether that will work is to ask the plugin's own
 * diagnostic. Its `doctor` subcommand is offline in the sense that matters —
 * it never sends a turn, so it never spends Start Plan quota — but it does start
 * the ZCode CLI, and step 5 starts a throwaway app-server. That is why the
 * diagnostic checks are side-effecting and never part of the default run.
 *
 * The `models` subcommand answers the catalog question without the rest, and the
 * `protocol` subcommand proves the app-server handshake while sending no turn.
 * `turn` and `image` spend quota; {@link PROHIBITED_COMMANDS} makes them
 * unreachable rather than merely discouraged.
 *
 * Nothing here reads a ZCode credential file. The plugin's own diagnostic reads
 * it and reports a length, never the token, which is the only version of that
 * fact this doctor is willing to carry.
 *
 * @module dsh-provider-doctor/providers/zcode/adapter
 */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CheckResult } from '../../shared/contract.ts'
import {
  cancelled,
  describeError,
  fail,
  notChecked,
  pass,
  timedOut,
  unknown,
} from '../../shared/check-helpers.ts'
import { REASON_CODES, type ReasonCode } from '../../shared/reason-codes.ts'
import type { AdapterContext, ProviderAdapter } from '../types.ts'
import { parseJsonFromOutput, resolvePluginCli, runPluginCli, type PluginCliOutcome } from '../process.ts'
import { modelCatalogCheck, providerConfigurableCheck, providerRegisteredCheck } from '../shared-checks.ts'
import { pluginEnabledCheck, pluginInstalledCheck } from '../../host/host-checks.ts'
import { readProfileDependencies } from '../../host/inventory.ts'

/** The package that registers the `zcode-cli` route. */
export const ZCODE_PACKAGE = 'dsh-zcode-plan-bridge'

/** The provider id that package registers. */
export const ZCODE_PROVIDER = 'zcode-cli'

/** The checks this adapter produces, in chain order. */
const CHECKS = [
  'plugin-installed',
  'plugin-enabled',
  'provider-registered',
  'provider-configurable',
  'credential-metadata',
  'model-catalog',
  'provider-diagnostic',
  'recent-error',
] as const

/** The shape the plugin's `doctor --json` summary carries, reduced to what we use. */
export interface ZcodeDoctorSummary {
  /** `doctor` or `models`. */
  command: string | undefined
  /** Whether every local precondition held. */
  ok: boolean
  /** The collected facts, keyed by step. */
  facts: Record<string, unknown>
}

/** How one CLI run settled, once its JSON document is parsed. */
export type CliReading =
  | { kind: 'summary'; summary: ZcodeDoctorSummary }
  | { kind: 'missing' }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string }
  | { kind: 'unreadable' }

/**
 * Reduce an untrusted CLI document to the summary this adapter reads.
 *
 * The plugin prints `{ command, ok, facts }` and `io.report` writes it verbatim,
 * but the document is still treated as untrusted: a version that renames a field
 * must degrade to `unreadable`, not crash the adapter.
 *
 * @param value - The parsed JSON document.
 * @returns The summary, or `undefined` when the shape is not one we read.
 */
export function readSummary(value: unknown): ZcodeDoctorSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  if (typeof root['ok'] !== 'boolean') return undefined
  const facts = root['facts']
  return {
    command: typeof root['command'] === 'string' ? root['command'] : undefined,
    ok: root['ok'],
    facts: typeof facts === 'object' && facts !== null && !Array.isArray(facts)
      ? (facts as Record<string, unknown>)
      : {},
  }
}

/** Run the plugin's CLI and parse its JSON summary. */
async function readCli(cliPath: string, args: readonly string[], context: AdapterContext): Promise<CliReading> {
  let outcome: PluginCliOutcome
  try {
    outcome = await runPluginCli({ cliPath, args, signal: context.signal, timeoutMs: context.budgetMs })
  } catch (error) {
    return { kind: 'failed', message: describeError(error) }
  }

  if (outcome.kind === 'output') {
    const parsed = parseJsonFromOutput(outcome.stdout)
    const summary = parsed === undefined ? undefined : readSummary(parsed)
    return summary === undefined ? { kind: 'unreadable' } : { kind: 'summary', summary }
  }
  if (outcome.kind === 'missing') return { kind: 'missing' }
  if (outcome.kind === 'killed') return outcome.aborted ? { kind: 'cancelled' } : { kind: 'timeout' }
  // A non-zero exit is not "no answer": the ZCode doctor prints its summary and
  // then exits 1 when a precondition failed, so the document is still read.
  const parsed = parseJsonFromOutput(outcome.stdout)
  const summary = parsed === undefined ? undefined : readSummary(parsed)
  if (summary !== undefined) return { kind: 'summary', summary }
  return { kind: 'failed', message: outcome.message }
}

/**
 * Read a boolean or string field out of one `facts` section.
 *
 * @param facts - The `facts` object.
 * @param key - The section name, e.g. `builtin`.
 * @param field - The field inside that section.
 * @returns The value, or `undefined`.
 */
function factField(facts: Record<string, unknown>, key: string, field: string): unknown {
  const section = facts[key]
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  return (section as Record<string, unknown>)[field]
}

/** Read the credential section's error code, when the CLI recorded one. */
function credentialErrorCode(summary: ZcodeDoctorSummary): string | undefined {
  const error = factField(summary.facts, 'credentials', 'error')
  return typeof error === 'string' && error !== '' ? error : undefined
}

/** Did the CLI report a usable Start Plan token? */
function hasCredential(summary: ZcodeDoctorSummary): boolean {
  const length = factField(summary.facts, 'credentials', 'planTokenLength')
  return typeof length === 'number' && length > 0
}

/** The number of models the CLI reported, when it reported a catalog. */
function catalogCount(summary: ZcodeDoctorSummary): number | undefined {
  const catalog = summary.facts['catalog']
  return Array.isArray(catalog) ? catalog.length : undefined
}

/** Map a ZCode credential error code onto this plugin's vocabulary. */
export function credentialReason(code: string | undefined): ReasonCode {
  switch (code) {
    case 'ENOENT':
      return REASON_CODES.credential_missing
    case 'EACCES':
    case 'EPERM':
    case 'EISDIR':
      return REASON_CODES.credential_unreadable
    default:
      return REASON_CODES.signed_out
  }
}

/** Build the credential check from a doctor summary. */
export function credentialFrom(summary: ZcodeDoctorSummary): CheckResult {
  const details: Record<string, unknown> = { provider: ZCODE_PROVIDER }
  const activeProvider = factField(summary.facts, 'credentials', 'activeProvider')
  if (typeof activeProvider === 'string') details['activeProvider'] = activeProvider
  const builtinVersion = factField(summary.facts, 'builtin', 'version')
  if (typeof builtinVersion === 'string') details['builtinVersion'] = builtinVersion

  const error = credentialErrorCode(summary)
  if (error !== undefined) {
    return fail({
      id: 'credential-metadata',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: credentialReason(error),
      summary: `The ZCode diagnostic could not read the Start Plan credential (${error}).`,
      nextSteps: ['Sign in with the ZCode desktop client, then run the connection check again.'],
      details: { ...details, credentialError: error },
    })
  }

  if (!hasCredential(summary)) {
    return fail({
      id: 'credential-metadata',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: REASON_CODES.credential_missing,
      summary: 'No Start Plan token is stored, so ZCode cannot sign a request.',
      nextSteps: ['Sign in with the ZCode desktop client, then run the connection check again.'],
      details,
    })
  }

  return pass({
    id: 'credential-metadata',
    evidenceKind: 'observed',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'A Start Plan token is stored and readable. Its validity is not tested without sending a turn.',
    details,
  })
}

/** Build the provider-diagnostic check from a doctor summary. */
export function diagnosticFrom(summary: ZcodeDoctorSummary): CheckResult {
  const details: Record<string, unknown> = { provider: ZCODE_PROVIDER }
  const node = summary.facts['node']
  if (typeof node === 'string') details['cliNodeVersion'] = node
  const cliPath = summary.facts['zcodeCliPath']
  // The path itself is a local filesystem detail; only its presence is reported.
  details['cliLocated'] = typeof cliPath === 'string' && cliPath !== ''
  const count = catalogCount(summary)
  if (count !== undefined) details['reportedModels'] = count
  const builtinSource = factField(summary.facts, 'builtin', 'source')
  if (typeof builtinSource === 'string') details['builtinSource'] = builtinSource

  if (!summary.ok) {
    return fail({
      id: 'provider-diagnostic',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: REASON_CODES.cli_runtime_unreadable,
      summary: 'The ZCode diagnostic reported at least one unmet local precondition.',
      nextSteps: [
        'Read the failing step in the ZCode bridge diagnostic, fix it, then run the connection check again.',
        'The usual causes are a missing ZCode CLI, an unreadable builtin runtime, or a missing Start Plan token.',
      ],
      details,
    })
  }

  return pass({
    id: 'provider-diagnostic',
    evidenceKind: 'observed',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The ZCode diagnostic reports every local precondition satisfied.',
    details,
  })
}

/**
 * Report the plugin CLI's presence without running it.
 *
 * This is what makes the default run honest for ZCode: the CLI's mere presence
 * is observable offline, while anything it would *say* requires starting it.
 */
async function cliPresence(cliPath: string | undefined): Promise<CheckResult> {
  if (cliPath === undefined) {
    return unknown({
      id: 'credential-metadata',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: 'offline',
      reasonCode: REASON_CODES.diagnostic_cli_missing,
      summary: `The ${ZCODE_PACKAGE} CLI is not present in this profile, so its diagnostic cannot run.`,
      nextSteps: [`Reinstall ${ZCODE_PACKAGE} in this profile.`],
      details: { provider: ZCODE_PROVIDER },
    })
  }
  return notChecked({
    id: 'credential-metadata',
    evidenceKind: 'unavailable',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    reasonCode: 'not_requested',
    summary:
      'Credential state comes from the ZCode diagnostic, which starts the CLI. Run the connection check to read it.',
    nextSteps: ['Use "Run the connection check" to include the ZCode diagnostic.'],
    details: { provider: ZCODE_PROVIDER, cli: 'available' },
  })
}

/**
 * Report whether the configured ZCode CLI file exists on disk.
 *
 * The plugin reads `zcodeCliPath` from its own settings; this doctor does not, so
 * it reports the CLI it would run (the plugin's own bin) rather than the ZCode
 * binary the plugin will spawn. That distinction is stated in the check, because
 * a present bridge CLI does not prove a present ZCode CLI.
 */
async function zcodeCliHint(): Promise<Record<string, unknown>> {
  const envPath = process.env['ZCODE_CLI_PATH']
  if (typeof envPath !== 'string' || envPath === '') return { zcodeCliConfigured: false }
  try {
    await access(envPath)
    return { zcodeCliConfigured: true, zcodeCliPresent: true }
  } catch {
    return { zcodeCliConfigured: true, zcodeCliPresent: false }
  }
}

/** Build the adapter. */
export const ZCODE_ADAPTER: ProviderAdapter = {
  id: ZCODE_PROVIDER,
  displayName: 'ZCode CLI',
  pluginName: ZCODE_PACKAGE,
  checks: CHECKS,

  async diagnose(context: AdapterContext): Promise<CheckResult[]> {
    const inventory = await readProfileInventory(context)
    const dependencies = readProfileDependencies(context.profileDir)
    const identity = { name: ZCODE_PACKAGE }

    const registration = providerRegisteredCheck({
      llm: context.host.llm,
      providerId: ZCODE_PROVIDER,
      pluginName: ZCODE_PACKAGE,
    })

    const checks: CheckResult[] = [
      pluginInstalledCheck({ pluginName: ZCODE_PACKAGE, identity, inventory, dependencies }),
      pluginEnabledCheck({ pluginName: ZCODE_PACKAGE, identity, inventory }),
      registration,
      providerConfigurableCheck({ llm: context.host.llm, providerId: ZCODE_PROVIDER }),
    ]

    const registered = registration.status === 'pass'
    const cliPath = await resolvePluginCli(context.profileDir, ZCODE_PACKAGE)
    const hint = await zcodeCliHint()

    if (!context.connectionCheck) {
      checks.push(await cliPresence(cliPath))
      // The ZCode bridge answers `listModels` by starting its resident
      // `app-server` and opening a probe session, so an offline run must not ask
      // for the catalog: the UI says this path starts no process.
      checks.push(
        await modelCatalogCheck({
          llm: context.host.llm,
          providerId: ZCODE_PROVIDER,
          registered,
          requested: false,
        }),
      )
      checks.push(
        notChecked({
          id: 'provider-diagnostic',
          evidenceKind: 'unavailable',
          source: 'provider_diagnostic',
          cost: 'side_effecting',
          reasonCode: cliPath === undefined ? REASON_CODES.diagnostic_cli_missing : 'not_requested',
          summary:
            cliPath === undefined
              ? `The ${ZCODE_PACKAGE} CLI is not present in this profile, so its diagnostic cannot run.`
              : 'The ZCode diagnostic was not run. It starts the CLI, so it only runs when you ask for the connection check.',
          nextSteps:
            cliPath === undefined
              ? [`Reinstall ${ZCODE_PACKAGE} in this profile.`]
              : ['Use "Run the connection check" to run the ZCode diagnostic.'],
          details: { provider: ZCODE_PROVIDER, ...hint },
        }),
      )
      checks.push(recentErrorNotRecorded())
      return checks
    }

    if (cliPath === undefined) {
      checks.push(
        unknown({
          id: 'credential-metadata',
          evidenceKind: 'unavailable',
          source: 'fallback',
          cost: 'offline',
          reasonCode: REASON_CODES.diagnostic_cli_missing,
          summary: `The ${ZCODE_PACKAGE} CLI is not present in this profile, so credential state cannot be read.`,
          nextSteps: [`Reinstall ${ZCODE_PACKAGE} in this profile, then run the connection check again.`],
          details: { provider: ZCODE_PROVIDER },
        }),
      )
      checks.push(
        await modelCatalogCheck({
          llm: context.host.llm,
          providerId: ZCODE_PROVIDER,
          registered,
          requested: context.connectionCheck,
        }),
      )
      checks.push(
        fail({
          id: 'provider-diagnostic',
          evidenceKind: 'unavailable',
          source: 'fallback',
          cost: 'side_effecting',
          reasonCode: REASON_CODES.diagnostic_cli_missing,
          summary: `The ${ZCODE_PACKAGE} CLI is not present in this profile, so the ZCode diagnostic could not run.`,
          nextSteps: [`Reinstall ${ZCODE_PACKAGE} in this profile.`],
          details: { provider: ZCODE_PROVIDER },
        }),
      )
      checks.push(recentErrorNotRecorded())
      return checks
    }

    const reading = await readCli(cliPath, ['doctor', '--json'], context)
    checks.push(await credentialCheckFrom(reading))
    // A requested connection check may start the client, so reading the catalog
    // is allowed here: the user already accepted a process for this run.
    checks.push(
      await modelCatalogCheck({
        llm: context.host.llm,
        providerId: ZCODE_PROVIDER,
        registered,
        requested: true,
      }),
    )
    checks.push(diagnosticCheckFrom(reading))
    checks.push(recentErrorNotRecorded())
    return checks
  },
}

/** Read the live inventory through the adapter context. */
async function readProfileInventory(context: AdapterContext) {
  const service = context.host.pluginInventory
  if (service === undefined) return undefined
  try {
    return await service.list()
  } catch {
    return undefined
  }
}

/** Credential check for one settled CLI reading. */
async function credentialCheckFrom(reading: CliReading): Promise<CheckResult> {
  switch (reading.kind) {
    case 'summary':
      return credentialFrom(reading.summary)
    case 'missing':
      return unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'fallback',
        cost: 'offline',
        reasonCode: REASON_CODES.diagnostic_cli_missing,
        summary: `The ${ZCODE_PACKAGE} CLI could not be started.`,
        nextSteps: [`Reinstall ${ZCODE_PACKAGE} in this profile.`],
        details: { provider: ZCODE_PROVIDER },
      })
    case 'cancelled':
      return cancelled({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        summary: 'The ZCode diagnostic was cancelled before it answered.',
        details: { provider: ZCODE_PROVIDER },
      })
    case 'timeout':
      return timedOut({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        summary: 'The ZCode diagnostic did not finish in time, so credential state is unknown. This is not a sign-out.',
        details: { provider: ZCODE_PROVIDER },
      })
    case 'unreadable':
      return unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: REASON_CODES.unsupported,
        summary: 'The ZCode diagnostic printed a document this plugin cannot read.',
        nextSteps: ['Update this plugin; the ZCode diagnostic report format may have changed.'],
        details: { provider: ZCODE_PROVIDER },
      })
    case 'failed':
      return unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: REASON_CODES.signed_out,
        summary: 'The ZCode diagnostic exited without a readable answer, so credential state is unknown.',
        nextSteps: ['Run the bridge CLI doctor from a terminal to read the full cause.'],
        details: { provider: ZCODE_PROVIDER, exitMessage: reading.message },
      })
  }
}

/** Provider-diagnostic check for one settled CLI reading. */
export function diagnosticCheckFrom(reading: CliReading): CheckResult {
  switch (reading.kind) {
    case 'summary':
      return diagnosticFrom(reading.summary)
    case 'missing':
      return fail({
        id: 'provider-diagnostic',
        evidenceKind: 'unavailable',
        source: 'fallback',
        cost: 'side_effecting',
        reasonCode: REASON_CODES.diagnostic_cli_missing,
        summary: `The ${ZCODE_PACKAGE} CLI could not be started.`,
        nextSteps: [`Reinstall ${ZCODE_PACKAGE} in this profile.`],
        details: { provider: ZCODE_PROVIDER },
      })
    case 'cancelled':
      return cancelled({
        id: 'provider-diagnostic',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        summary: 'The ZCode diagnostic was cancelled before it answered.',
        details: { provider: ZCODE_PROVIDER },
      })
    case 'timeout':
      return timedOut({
        id: 'provider-diagnostic',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        summary: 'The ZCode diagnostic did not finish in time. This is not a sign-out.',
        details: { provider: ZCODE_PROVIDER },
      })
    case 'unreadable':
      return fail({
        id: 'provider-diagnostic',
        evidenceKind: 'observed',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: REASON_CODES.unsupported,
        summary: 'The ZCode diagnostic report is not in a shape this plugin can read.',
        nextSteps: ['Update this plugin; the ZCode diagnostic report format may have changed.'],
        details: { provider: ZCODE_PROVIDER },
      })
    case 'failed':
      return fail({
        id: 'provider-diagnostic',
        evidenceKind: 'observed',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: REASON_CODES.internal_error,
        summary: 'The ZCode diagnostic failed to produce a report.',
        nextSteps: ['Run the bridge CLI doctor from a terminal to read the unredacted cause.'],
        details: { provider: ZCODE_PROVIDER, exitMessage: reading.message },
      })
  }
}

/** ZCode keeps no record of the last request outcome, so this is always unknown. */
function recentErrorNotRecorded(): CheckResult {
  return unknown({
    id: 'recent-error',
    evidenceKind: 'unavailable',
    source: 'local_metadata',
    reasonCode: REASON_CODES.unsupported,
    summary: 'ZCode keeps no local record of the last request outcome, so this link cannot be observed.',
    nextSteps: ['Use the connection check to run the ZCode diagnostic instead.'],
    details: { provider: ZCODE_PROVIDER },
  })
}

/** The bridge CLI's own version, read from its manifest without running it. */
export async function readZcodePackageVersion(profileDir: string | undefined): Promise<string | undefined> {
  if (profileDir === undefined) return undefined
  try {
    const text = await readFile(join(profileDir, 'node_modules', ZCODE_PACKAGE, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const version = (parsed as Record<string, unknown>)['version']
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}
