/**
 * The WorkBuddy and WorkBuddy AI adapters.
 *
 * One npm package registers both provider routes, so the two adapters differ
 * only in the variant they pass to the plugin's own CLI. Everything else — the
 * plugin's install state, its route registration, its credential handling — is
 * shared evidence about the same loaded plugin.
 *
 * The evidence comes from three places, in decreasing order of authority:
 *
 * 1. `ctx.llm` and `ctx.pluginInventory` — the live host (offline, in-process);
 * 2. the profile's manifest — local metadata, when the inventory is absent;
 * 3. the plugin's own `doctor` CLI — the only source that knows the sign-in
 *    state, and the only one that starts a child process.
 *
 * That third source is why `credential-metadata` and `provider-diagnostic` are
 * side-effecting checks: one `doctor` invocation answers both, and the doctor
 * never runs it unless the operator asked for the connection check.
 *
 * @module dsh-provider-doctor/providers/workbuddy/adapter
 */

import type { CheckResult } from '../../shared/contract.ts'
import {
  cancelled,
  describeError,
  fail,
  notChecked,
  pass,
  timedOut,
  unknown,
  warn,
} from '../../shared/check-helpers.ts'
import { REASON_CODES } from '../../shared/reason-codes.ts'
import { readProfileDependencies as readProfileDependencyMap } from '../../host/inventory.ts'
import { pluginEnabledCheck, pluginInstalledCheck } from '../../host/host-checks.ts'
import type { AdapterContext, ProviderAdapter } from '../types.ts'
import { runPluginCli, type PluginCliOutcome } from '../process.ts'
import { hasProbeStore, recentErrorCheck } from '../recent-error.ts'
import {
  WORKBUDDY_PACKAGE,
  WORKBUDDY_VARIANTS,
  extractJsonObject,
  isWorkBuddyElectronReason,
  readDoctorJson,
  resolveWorkBuddyCli,
  workBuddyReasonFor,
  type WorkBuddyDoctorJson,
  type WorkBuddyVariantSpec,
} from './plugin-package.ts'
import { modelCatalogCheck, providerConfigurableCheck, providerRegisteredCheck } from '../shared-checks.ts'

/** Checks every WorkBuddy variant produces. */
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

/** The slice of `ctx.pluginInventory.list()` this adapter reads. */
type InventorySnapshot = Awaited<ReturnType<NonNullable<AdapterContext['host']['pluginInventory']>['list']>>

/** What one CLI invocation produced, once the wrapper's vocabulary is applied. */
export type CliReading =
  | { kind: 'json'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string; stdout: string; stderr: string }

/**
 * Build one variant's adapter.
 *
 * @param variant - Which WorkBuddy product this adapter diagnoses.
 * @returns A ready-to-run adapter; the same function serves WorkBuddy AI.
 */
function createAdapter(variant: WorkBuddyVariantSpec): ProviderAdapter {
  return {
    id: variant.id,
    displayName: variant.displayName,
    pluginName: WORKBUDDY_PACKAGE,
    checks: CHECKS,

    async diagnose(context: AdapterContext): Promise<CheckResult[]> {
      const inventory = await readInventory(context)
      const dependencies = readProfileDependencyMap(context.profileDir)
      const identity = { name: WORKBUDDY_PACKAGE }

      const registration = providerRegisteredCheck({
        llm: context.host.llm,
        providerId: variant.id,
        pluginName: WORKBUDDY_PACKAGE,
      })

      const checks: CheckResult[] = [
        pluginInstalledCheck({ pluginName: WORKBUDDY_PACKAGE, identity, inventory, dependencies }),
        pluginEnabledCheck({ pluginName: WORKBUDDY_PACKAGE, identity, inventory }),
        registration,
        providerConfigurableCheck({ llm: context.host.llm, providerId: variant.id }),
      ]

      const cli = resolveWorkBuddyCli({
        dshHome: context.dshHome,
        ...context.profileDir === undefined ? {} : { profileDir: context.profileDir },
      })
      const cliCheck = await diagnoseCredential(context, cli, variant.id)
      checks.push(cliCheck.credential)
      checks.push(
        await modelCatalogCheck({
          llm: context.host.llm,
          providerId: variant.id,
          registered: registration.status === 'pass',
        }),
      )
      checks.push(cliCheck.diagnostic)
      checks.push(recentErrorFor(context, variant.id))
      return checks
    },
  }
}

/**
 * Read the live inventory, or `undefined` when this host has none.
 *
 * The service is optional by design: the gateway is mounted by `dsh-web-app`, so
 * a headless composition has no inventory and every install check degrades to
 * "unknown" rather than to "missing".
 *
 * @param context - The adapter's context.
 * @returns The normalised snapshot, or `undefined`.
 */
async function readInventory(context: AdapterContext): Promise<InventorySnapshot | undefined> {
  const service = context.host.pluginInventory
  if (service === undefined) return undefined
  try {
    return await service.list()
  } catch {
    return undefined
  }
}

/** Run the plugin's CLI once, translating the wrapper's vocabulary. */
async function readCli(
  cliPath: string,
  args: readonly string[],
  context: AdapterContext,
): Promise<CliReading> {
  let outcome: PluginCliOutcome
  try {
    outcome = await runPluginCli({
      cliPath,
      args,
      signal: context.signal,
      timeoutMs: context.budgetMs,
    })
  } catch (error) {
    return { kind: 'failed', message: describeError(error), stdout: '', stderr: '' }
  }

  if (outcome.kind === 'output') {
    const parsed = extractJsonObject(outcome.stdout)
    return parsed === undefined
      ? { kind: 'failed', message: 'the diagnostic printed no JSON document', stdout: outcome.stdout, stderr: outcome.stderr }
      : { kind: 'json', value: parsed }
  }
  if (outcome.kind === 'missing') return { kind: 'missing' }
  if (outcome.kind === 'killed') return outcome.aborted ? { kind: 'cancelled' } : { kind: 'timeout' }
  return { kind: 'failed', message: outcome.message, stdout: outcome.stdout, stderr: outcome.stderr }
}

/**
 * The two checks that need the provider's own CLI.
 *
 * One `doctor --json` run answers both, so they are produced together: the run
 * either proves the credential is readable, or says exactly why it is not.
 */
async function diagnoseCredential(
  context: AdapterContext,
  cliPath: string | undefined,
  providerId: string,
): Promise<{ credential: CheckResult; diagnostic: CheckResult }> {
  if (cliPath === undefined) {
    return {
      credential: credentialMissingCli(providerId),
      diagnostic: diagnosticMissingCli(providerId, context.connectionCheck),
    }
  }

  if (!context.connectionCheck) {
    return {
      credential: notChecked({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'not_requested',
        summary:
          'Credential state comes from the provider\'s own diagnostic, which starts a local process. Run the connection check to read it.',
        nextSteps: ['Use "Run the connection check" to include the provider\'s own diagnostic.'],
        details: { provider: providerId, cli: 'available' },
      }),
      diagnostic: notChecked({
        id: 'provider-diagnostic',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'not_requested',
        summary:
          'The provider\'s own diagnostic was not run. It starts a local process and reads the sign-in state, so it only runs when you ask for the connection check.',
        nextSteps: ['Use "Run the connection check" to run the provider\'s diagnostic.'],
        details: { provider: providerId, cli: 'available' },
      }),
    }
  }

  const reading = await readCli(cliPath, ['doctor', '--json', '--provider', variantCliId(providerId)], context)
  return interpretDoctor(reading, providerId)
}

/** The `--provider` value the CLI expects for one doctor provider id. */
export function variantCliId(providerId: string): string {
  return providerId === 'workbuddy-ai' ? 'workbuddy-ai' : 'workbuddy'
}

/** Turn one CLI reading into the credential and diagnostic checks. */
export function interpretDoctor(
  reading: CliReading,
  providerId: string,
): { credential: CheckResult; diagnostic: CheckResult } {
  if (reading.kind === 'missing') {
    return { credential: credentialMissingCli(providerId), diagnostic: diagnosticMissingCli(providerId, true) }
  }
  if (reading.kind === 'cancelled') {
    return { credential: credentialCancelled(providerId), diagnostic: diagnosticCancelled(providerId) }
  }
  if (reading.kind === 'timeout') {
    return { credential: credentialTimedOut(providerId), diagnostic: diagnosticTimedOut(providerId) }
  }
  if (reading.kind === 'failed') {
    // A CLI that could not start is not a signed-out account. The distinction
    // matters: `signed_out` tells the reader to sign in again, which would be
    // the wrong repair when the executable never got as far as reading a token.
    const launchFailure = isLaunchFailure(reading)
    return {
      credential: unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: launchFailure ? 'diagnostic_cli_unloadable' : 'signed_out',
        summary: launchFailure
          ? 'The provider\'s diagnostic could not start: it reported a missing module rather than a credential state.'
          : 'The provider\'s diagnostic exited without a readable answer, so credential state is unknown.',
        nextSteps: launchFailure
          ? [
              'The provider\'s CLI needs its @deepseek-ai peer packages resolvable from the profile that installed it.',
              'Reinstall the provider plugin in this profile, then run the connection check again.',
            ]
          : ['Run the provider\'s diagnostic from a terminal to see its full output.'],
        details: { provider: providerId, exitMessage: reading.message },
      }),
      diagnostic: fail({
        id: 'provider-diagnostic',
        evidenceKind: 'observed',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: launchFailure ? 'diagnostic_cli_unloadable' : 'internal_error',
        summary: launchFailure
          ? 'The provider\'s own diagnostic never ran: its executable could not resolve a module it imports.'
          : 'The provider\'s own diagnostic failed to produce a report.',
        nextSteps: launchFailure
          ? ['Reinstall the provider plugin in this profile so its peer packages resolve, then run the connection check again.']
          : ['Run the provider\'s CLI doctor from a terminal to read the unredacted cause.'],
        details: { provider: providerId, exitMessage: reading.message },
      }),
    }
  }

  const doctor: WorkBuddyDoctorJson | undefined = readDoctorJson(reading.value)
  // Both variants share one CLI and one document shape, so a document that names
  // the *other* variant would otherwise be read as this variant's credential
  // state. Refuse it instead: the two variants have different accounts and
  // different sign-in state.
  const declared = declaredProvider(reading.value)
  if (declared !== undefined && declared !== providerId) {
    return {
      credential: unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'unsupported',
        summary: `The provider's diagnostic answered for "${declared}" instead of "${providerId}".`,
        nextSteps: ['Update this plugin; the provider CLI may be ignoring the --provider it was given.'],
        details: { provider: providerId, answeredFor: declared },
      }),
      diagnostic: fail({
        id: 'provider-diagnostic',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'unsupported',
        summary: 'The provider\'s diagnostic answered for a different variant than the one being checked.',
        nextSteps: ['Update this plugin; the provider CLI may be ignoring the --provider it was given.'],
        details: { provider: providerId, answeredFor: declared },
      }),
    }
  }
  if (doctor === undefined) {
    return {
      credential: unknown({
        id: 'credential-metadata',
        evidenceKind: 'unavailable',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'internal_error',
        summary: 'The provider\'s diagnostic printed a document this plugin does not recognise.',
        nextSteps: ['Update this plugin, or run the provider CLI with --json and report its shape.'],
        details: { provider: providerId },
      }),
      diagnostic: fail({
        id: 'provider-diagnostic',
        evidenceKind: 'observed',
        source: 'provider_diagnostic',
        cost: 'side_effecting',
        reasonCode: 'unsupported',
        summary: 'The provider\'s diagnostic report is not in the shape this plugin can read.',
        nextSteps: ['Update this plugin; the provider CLI report format may have changed.'],
        details: { provider: providerId },
      }),
    }
  }

  return {
    credential: credentialFrom(doctor, providerId),
    diagnostic: diagnosticFrom(doctor, providerId),
  }
}

/** Build the credential check from a parsed `doctor --json` document. */
export function credentialFrom(doctor: WorkBuddyDoctorJson, providerId: string): CheckResult {
  const details: Record<string, unknown> = { provider: providerId }
  if (doctor.pluginVersion !== undefined) details['pluginVersion'] = doctor.pluginVersion
  if (doctor.desktopAuthFormat !== undefined) details['desktopAuthFormat'] = doctor.desktopAuthFormat
  if (doctor.desktopAuthPresent !== undefined) details['desktopAuthPresent'] = doctor.desktopAuthPresent
  if (doctor.hostHeartbeatPresent !== undefined) details['hostHeartbeatPresent'] = doctor.hostHeartbeatPresent

  if (doctor.signIn === 'signed-in') {
    return pass({
      id: 'credential-metadata',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      summary: `The provider reports a signed-in state (credential format: ${doctor.desktopAuthFormat ?? 'unreported'}).`,
      details,
    })
  }

  const code = doctor.reasonCode
  const reason = workBuddyReasonFor(code)
  // An Electron discovery failure is a local environment problem on the way to
  // the credential file, not proof that the person is signed out.
  const summary = code === undefined
    ? 'The provider reports a signed-out state without naming a cause.'
    : isWorkBuddyElectronReason(code)
      ? `The provider could not reach its desktop app to read the credential (${code}).`
      : `The provider reports a signed-out state (${code}).`

  if (doctor.signIn === 'error') {
    return unknown({
      id: 'credential-metadata',
      evidenceKind: 'unavailable',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: reason,
      summary: 'The provider could not finish reading its credential state.',
      nextSteps: ['Run the provider CLI doctor from a terminal to see the full cause.'],
      details: { ...details, ...code === undefined ? {} : { providerReasonCode: code } },
    })
  }

  return fail({
    id: 'credential-metadata',
    evidenceKind: 'observed',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    reasonCode: reason,
    summary,
    nextSteps: credentialNextSteps(code),
    details: { ...details, ...code === undefined ? {} : { providerReasonCode: code } },
  })
}

/** The operator's next step, chosen by the provider's own reason code. */
function credentialNextSteps(code: string | undefined): string[] {
  switch (code) {
    case 'no-credential':
      return ['Sign in once in the WorkBuddy desktop app, then run the connection check again.']
    case 'encrypted-credential-unreadable':
      return ['Reopen the WorkBuddy desktop app so it can re-seal the token, then ask DSH to unlock it again.']
    case 'credential-region-mismatch':
      return ['Set the region this account belongs to in the provider settings, then re-run the check.']
    default:
      if (code !== undefined && code.startsWith('electron-')) {
        return ['Install or update the WorkBuddy desktop app, and make sure it is reachable from this machine.']
      }
      return ['Open the WorkBuddy plugin settings and follow its sign-in guidance, then re-run the connection check.']
  }
}

/** The `provider` a diagnostic document names, when it names one. */
function declaredProvider(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { provider?: unknown }).provider
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

/**
 * Whether a failed CLI run died on module resolution rather than on its work.
 *
 * Measured on a real profile: a plugin installed without its `@deepseek-ai`
 * peers makes `node <bin>` abort with `ERR_MODULE_NOT_FOUND` before any of the
 * provider's own code runs. Reporting that as `signed_out` would send someone
 * to sign in again for a packaging fault, so the two causes are kept apart.
 */
export function isLaunchFailure(reading: { message: string; stderr?: string }): boolean {
  const text = `${reading.message}\n${reading.stderr ?? ''}`
  return (
    text.includes('ERR_MODULE_NOT_FOUND') ||
    text.includes('Cannot find package') ||
    text.includes('Cannot find module')
  )
}

/** Build the provider-diagnostic check from a parsed `doctor --json` document. */
export function diagnosticFrom(doctor: WorkBuddyDoctorJson, providerId: string): CheckResult {
  const details: Record<string, unknown> = { provider: providerId }
  if (doctor.pluginVersion !== undefined) details['pluginVersion'] = doctor.pluginVersion
  if (doctor.signIn !== undefined) details['signIn'] = doctor.signIn
  if (doctor.fallbackModels !== undefined) details['fallbackModels'] = doctor.fallbackModels
  if (doctor.hostHeartbeatProcessAlive !== undefined) {
    details['hostBundleProcessAlive'] = doctor.hostHeartbeatProcessAlive
  }

  if (doctor.signIn === 'error') {
    return fail({
      id: 'provider-diagnostic',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: 'internal_error',
      summary: 'The provider\'s own diagnostic ended in an error state.',
      nextSteps: ['Read the provider CLI output in a terminal to see the failing step.'],
      details,
    })
  }

  if (doctor.hostHeartbeatProcessAlive === false) {
    return warn({
      id: 'provider-diagnostic',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: 'plugin_not_loaded',
      summary:
        'The provider\'s host bundle recorded a heartbeat but that process is no longer running, so its routes will not answer.',
      nextSteps: ['Reload DSH so the plugin starts again, then re-run the connection check.'],
      details,
    })
  }

  return pass({
    id: 'provider-diagnostic',
    evidenceKind: 'observed',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The provider\'s own diagnostic ran and reported no internal problem.',
    details,
  })
}

/** Credential check when the plugin's CLI could not be located. */
function credentialMissingCli(providerId: string): CheckResult {
  return unknown({
    id: 'credential-metadata',
    evidenceKind: 'unavailable',
    source: 'fallback',
    cost: 'offline',
    reasonCode: 'diagnostic_cli_missing',
    summary: `The ${WORKBUDDY_PACKAGE} CLI is not present in this profile, so credential state cannot be read.`,
    nextSteps: [`Reinstall ${WORKBUDDY_PACKAGE} in this profile, then run the diagnosis again.`],
    details: { provider: providerId },
  })
}

/** Provider-diagnostic check when the plugin's CLI could not be located. */
function diagnosticMissingCli(providerId: string, requested: boolean): CheckResult {
  if (!requested) {
    return notChecked({
      id: 'provider-diagnostic',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: 'side_effecting',
      reasonCode: 'diagnostic_cli_missing',
      summary: `The ${WORKBUDDY_PACKAGE} CLI is not present in this profile, so its own diagnostic cannot run.`,
      nextSteps: [`Reinstall ${WORKBUDDY_PACKAGE} in this profile.`],
      details: { provider: providerId },
    })
  }
  return fail({
    id: 'provider-diagnostic',
    evidenceKind: 'unavailable',
    source: 'fallback',
    cost: 'side_effecting',
    reasonCode: 'diagnostic_cli_missing',
    summary: `The ${WORKBUDDY_PACKAGE} CLI is not present in this profile, so its own diagnostic could not run.`,
    nextSteps: [`Reinstall ${WORKBUDDY_PACKAGE} in this profile, then re-run the connection check.`],
    details: { provider: providerId },
  })
}

/** Credential check for a run the operator stopped. */
function credentialCancelled(providerId: string): CheckResult {
  return cancelled({
    id: 'credential-metadata',
    evidenceKind: 'unavailable',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The provider\'s diagnostic was cancelled before it answered.',
    details: { provider: providerId },
  })
}

/** Provider-diagnostic check for a run the operator stopped. */
function diagnosticCancelled(providerId: string): CheckResult {
  return cancelled({
    id: 'provider-diagnostic',
    evidenceKind: 'unavailable',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The provider\'s diagnostic was cancelled before it answered.',
    details: { provider: providerId },
  })
}

/** Credential check for a diagnostic that outlived its budget. */
function credentialTimedOut(providerId: string): CheckResult {
  return timedOut({
    id: 'credential-metadata',
    evidenceKind: 'unavailable',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The provider\'s diagnostic did not finish in time, so credential state is unknown. This is not a sign-out.',
    details: { provider: providerId },
  })
}

/** Provider-diagnostic check for a diagnostic that outlived its budget. */
function diagnosticTimedOut(providerId: string): CheckResult {
  return timedOut({
    id: 'provider-diagnostic',
    evidenceKind: 'unavailable',
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    summary: 'The provider\'s diagnostic did not finish in time. This is not a sign-out.',
    details: { provider: providerId },
  })
}

/**
 * The recent-error link, read from the plugin's own probe store.
 *
 * @param context - The adapter context.
 * @param providerId - Which probe store to read.
 * @returns The `recent-error` check.
 */
function recentErrorFor(context: AdapterContext, providerId: string): CheckResult {
  if (!hasProbeStore(providerId)) {
    return unknown({
      id: 'recent-error',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: REASON_CODES.unsupported,
      summary: 'This provider keeps no record of the last request outcome.',
      details: { provider: providerId },
    })
  }
  return recentErrorCheck({ dshHome: context.dshHome, provider: providerId })
}

/** Both WorkBuddy adapters, in the order the UI lists providers. */
export const WORKBUDDY_ADAPTERS: readonly ProviderAdapter[] = WORKBUDDY_VARIANTS.map(createAdapter)
