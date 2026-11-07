/**
 * The host-layer checks, and the plugin checks every provider adapter reuses.
 *
 * Two rules shape this file:
 *
 * - **Never invent a fact.** A version that could not be read stays absent and
 *   the check says `unknown`; a plugin whose install state could not be read is
 *   not reported as missing. The operator can act on "could not confirm"; they
 *   cannot act on a guess.
 * - **Never inflate a verdict.** An out-of-range host is a warning, not a
 *   failure: the diagnosis still ran and its result is still evidence. Only a
 *   link that is definitively broken — a disabled plugin, a failed fiber — fails.
 *
 * Every result is built through {@link makeCheck}, which redacts summaries, next
 * steps and details, so a provider's raw diagnostic may be passed through as-is.
 *
 * @module dsh-provider-doctor/host/host-checks
 */

import type { CheckResult, EvidenceKind, EvidenceSource } from '../shared/contract.ts'
import { fail, notChecked, pass, unknown, warn } from '../shared/check-helpers.ts'
import type {
  PluginIdentity,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '../providers/types.ts'
import { checkEngineRange, type HostFacts, type ProfileFacts } from './runtime.ts'
import { findEntryByPackage, resolvePluginStateFromEvidence } from './inventory.ts'

/** The shared cost classification for every check in this file. */
const OFFLINE = 'offline' as const

/**
 * Report the DSH build against the range this plugin declares.
 *
 * The declared range is read from this plugin's own `engines.dsh`, so a passing
 * check means "this is a build the plugin was verified on", not "this is the
 * latest build".
 *
 * @param input - The host facts and the range from `package.json`.
 * @returns `pass` in range, `warning` out of range, `unknown` when unreadable.
 */
export function hostRuntimeCheck(input: { facts: HostFacts; declaredRange: string }): CheckResult {
  const { facts, declaredRange } = input
  const details: Record<string, unknown> = {
    nodeVersion: facts.nodeVersion,
    platform: facts.platform,
    arch: facts.arch,
    declaredRange,
  }
  const dshVersion = facts.dshVersion
  if (dshVersion === undefined) {
    return unknown({
      id: 'host-runtime',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'host_version_unreadable',
      summary: 'The DSH build could not be read from this process, so compatibility cannot be checked.',
      nextSteps: [
        'Re-run the diagnosis from the DSH profile that loaded this plugin.',
        'If the plugin was bundled into another app, pass the host version explicitly when starting the run.',
      ],
      details,
    })
  }

  details['dshVersion'] = dshVersion
  const range = checkEngineRange(dshVersion, declaredRange)
  if (range.ok) {
    return pass({
      id: 'host-runtime',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      summary: `DSH ${dshVersion} is inside the verified range (${declaredRange}).`,
      details,
    })
  }
  if (range.reason === 'invalid_version') {
    // A version was reported but is not a version this plugin can compare. That
    // is a reading failure, not a mismatch: calling it out of range would be a
    // claim about a string nobody parsed.
    return unknown({
      id: 'host-runtime',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'host_version_unreadable',
      summary: `The reported DSH version (${dshVersion}) is not a version this plugin can compare.`,
      nextSteps: ['Report the exact version string to the plugin maintainer.'],
      details,
    })
  }
  if (range.reason === 'invalid_range') {
    return unknown({
      id: 'host-runtime',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'internal_error',
      summary: `This plugin's declared DSH range (${declaredRange}) could not be parsed.`,
      nextSteps: ['Reinstall the plugin; its package manifest is damaged.'],
      details,
    })
  }
  return warn({
    id: 'host-runtime',
    evidenceKind: 'observed',
    source: 'live_host',
    cost: OFFLINE,
    reasonCode: 'host_version_mismatch',
    summary: `DSH ${dshVersion} is outside the range this plugin was verified against (${declaredRange}).`,
    nextSteps: [
      'Update the plugin or the DSH build so the two overlap, then re-run the diagnosis.',
      'Treat the remaining checks as evidence about a build this plugin does not officially support.',
    ],
    details,
  })
}

/**
 * Report which profile the evidence came from.
 *
 * A profile that was guessed from several candidates is still reported as
 * found, but the check carries `inferred` and the guess is disclosed in the
 * details. Only a profile that could not be located at all is `unknown`.
 *
 * @param input - The resolved profile facts.
 * @returns A check whose evidence kind mirrors the resolution's strength.
 */
export function profileIdentityCheck(input: { profile: ProfileFacts }): CheckResult {
  const { profile } = input
  const evidenceSource: EvidenceSource = profile.source === 'injected' ? 'user_supplied' : 'local_metadata'
  const candidateCount = profile.candidates.length
  const ignored = profile.ignoredEnvProfile

  if (profile.evidence === 'unavailable' || profile.name === undefined) {
    const details: Record<string, unknown> = { candidateCount, resolution: profile.source }
    if (ignored !== undefined) details['ignoredEnvProfile'] = ignored
    return unknown({
      id: 'profile-identity',
      evidenceKind: 'unavailable',
      source: evidenceSource,
      cost: OFFLINE,
      reasonCode: 'profile_unresolved',
      summary:
        candidateCount === 0
          ? 'No DSH profile directory could be located, so the plugin evidence has no profile to come from.'
          : `${candidateCount} DSH profiles exist and none identifies the running one.`,
      nextSteps: [
        'Start the diagnosis from the profile that is actually running, or set DSH_PROFILE to its name.',
      ],
      details,
    })
  }

  const details: Record<string, unknown> = {
    name: profile.name,
    candidateCount,
    resolution: profile.source,
  }
  if (ignored !== undefined) details['ignoredEnvProfile'] = ignored
  // `DSH_PROFILE` inherited from the shell that launched the host names the
  // *parent's* profile. Saying so keeps the reader from believing an unrelated
  // profile was consulted.
  const discarded =
    ignored === undefined
      ? undefined
      : `DSH_PROFILE named "${ignored}", which does not exist under this DSH home, so it was ignored.`

  if (profile.evidence === 'inferred') {
    details['inferred'] = true
    return pass({
      id: 'profile-identity',
      evidenceKind: 'inferred',
      source: evidenceSource,
      cost: OFFLINE,
      summary: `The running profile was inferred as "${profile.name}": ${candidateCount} profiles exist and this is the Desktop one.${discarded === undefined ? '' : ` ${discarded}`}`,
      nextSteps: ['Set DSH_PROFILE if this is not the profile that is actually running.'],
      details,
    })
  }
  return pass({
    id: 'profile-identity',
    evidenceKind: 'observed',
    source: evidenceSource,
    cost: OFFLINE,
    summary: `The evidence came from the "${profile.name}" profile.${discarded === undefined ? '' : ` ${discarded}`}`,
    details,
  })
}

/** What every provider adapter passes to the shared plugin checks. */
export interface PluginCheckInput {
  /** npm package name that owns the provider route. */
  pluginName: string
  /** The adapter's own identity for the plugin. */
  identity: PluginIdentity
  /** The live inventory snapshot, when this host exposes one. */
  inventory: PluginInventorySnapshot | undefined
}

/** The install check's input: the plugin check plus the profile's records. */
export interface PluginInstalledCheckInput extends PluginCheckInput {
  /** The profile's dependency records, when its manifest was readable. */
  dependencies: Record<string, string> | undefined
}

/**
 * Report whether the provider's plugin package is installed in this profile.
 *
 * Three sources are distinguishable and the check names the one it used: the
 * live inventory (observed), the loader table (inferred), or the profile's own
 * dependency records (`local_metadata`). None of them is a reason to install on
 * the operator's behalf — the check points at the plugin management page and
 * stops there.
 *
 * @param input - Package name, adapter identity, inventory and dependency records.
 * @returns `pass` installed, `fail` definitively absent, `unknown` unreadable.
 */
export function pluginInstalledCheck(input: PluginInstalledCheckInput): CheckResult {
  const packageName = input.pluginName === '' ? input.identity.name : input.pluginName
  const state = resolveInstalledState(packageName, input.identity, input.inventory, input.dependencies)

  if (state.present === true) {
    const details: Record<string, unknown> = { package: packageName, evidence: state.source }
    if (state.entry !== undefined) details['entryId'] = state.entry.entryId
    if (input.identity.version !== undefined) details['version'] = input.identity.version
    return pass({
      id: 'plugin-installed',
      evidenceKind: installedEvidenceKind(state.source),
      source: installedSource(state.source),
      cost: OFFLINE,
      summary:
        state.source === 'manifest'
          ? `${packageName} is declared in the profile's dependency records.`
          : `${packageName} is present in the live plugin inventory.`,
      details,
    })
  }

  if (state.present === false) {
    return fail({
      id: 'plugin-installed',
      evidenceKind: installedEvidenceKind(state.source),
      source: installedSource(state.source),
      cost: OFFLINE,
      reasonCode: 'plugin_missing',
      summary: `${packageName} is not installed in this profile, so its provider route cannot exist.`,
      nextSteps: [
        `Install ${packageName} from the DSH plugin management page, then re-run the diagnosis.`,
      ],
      details: { package: packageName, evidence: state.source },
    })
  }

  return unknown({
    id: 'plugin-installed',
    evidenceKind: 'unavailable',
    source: 'fallback',
    cost: OFFLINE,
    reasonCode: 'inventory_unavailable',
    summary: `This host exposes no plugin inventory and the profile's dependency records could not be read, so install state is unknown.`,
    nextSteps: [
      'Run the diagnosis from the DSH Web or Desktop app, which mounts the plugin inventory.',
    ],
    details: { package: packageName },
  })
}

/**
 * Report whether the installed plugin is loaded and running.
 *
 * The enabled flag, the fiber phase and the loader's own diagnostic are one
 * story: a plugin can be installed, enabled, and still have failed to start.
 * `failed` is a failure with the fiber's diagnostic attached; a phase that is
 * merely transient is a warning, because the snapshot caught it mid-flight.
 *
 * @param input - Package name, adapter identity and the live inventory.
 * @returns `pass` active, `fail` disabled or failed, `warning`/`unknown`/`not_checked` otherwise.
 */
export function pluginEnabledCheck(input: PluginCheckInput): CheckResult {
  const packageName = input.pluginName === '' ? input.identity.name : input.pluginName
  const entry = findEntry(packageName, input.identity, input.inventory)

  if (entry === undefined) {
    // Without a row there is nothing to observe. The install check owns the
    // "is it there at all" question, so this one declines rather than guessing.
    return notChecked({
      id: 'plugin-enabled',
      evidenceKind: 'unavailable',
      source: input.inventory === undefined ? 'fallback' : 'live_host',
      cost: OFFLINE,
      reasonCode: 'not_requested',
      summary:
        input.inventory === undefined
          ? 'No plugin inventory is available in this host, so the enabled state could not be read.'
          : `${packageName} has no row in the live inventory, so there is no enabled state to report.`,
      details: { package: packageName },
    })
  }

  const details: Record<string, unknown> = {
    package: packageName,
    entryId: entry.entryId,
    enabled: entry.enabled,
    fiberPhase: entry.fiberPhase,
  }

  if (!entry.enabled) {
    return fail({
      id: 'plugin-enabled',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'plugin_disabled',
      summary: `${packageName} is installed but disabled, so its provider route is not registered.`,
      nextSteps: [`Enable ${packageName} on the DSH plugin management page, then re-run the diagnosis.`],
      details,
    })
  }

  const phase = entry.fiberPhase
  if (phase === 'failed') {
    // The diagnostic is deliberately passed through untouched: makeCheck
    // redacts it, and the raw text is what the operator needs to act on.
    if (entry.diagnostic !== undefined) details['diagnostic'] = entry.diagnostic
    return fail({
      id: 'plugin-enabled',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'plugin_failed',
      summary: `${packageName} is enabled but its loader entry failed to start.`,
      nextSteps: [
        `Read the diagnostic above, fix the cause, then reload ${packageName}.`,
        'Check the DSH log for the full stack trace of this entry.',
      ],
      details,
    })
  }

  if (phase === 'active') {
    return pass({
      id: 'plugin-enabled',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      summary: `${packageName} is enabled and active.`,
      details,
    })
  }

  if (phase === 'pending' || phase === 'loading' || phase === 'unloading') {
    return warn({
      id: 'plugin-enabled',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'plugin_not_loaded',
      summary: `${packageName} is enabled and its loader entry is ${phase}; the snapshot caught it mid-transition.`,
      nextSteps: ['Re-run the diagnosis once the plugin has finished loading.'],
      details,
    })
  }

  // `null` phase: the entry exists but this inventory does not say what state
  // its fiber is in. Reporting "not loaded" would overstate what was observed.
  return unknown({
    id: 'plugin-enabled',
    evidenceKind: 'unavailable',
    source: 'live_host',
    cost: OFFLINE,
    reasonCode: 'plugin_not_loaded',
    summary: `${packageName} is enabled, but the inventory did not report its fiber phase.`,
    nextSteps: ['Re-run the diagnosis, or check the plugin management page for this entry.'],
    details,
  })
}

/** The state the install check reduces the evidence to. */
interface InstalledState {
  present: boolean | undefined
  entry?: PluginInventoryEntry
  source: 'inventory' | 'loader' | 'manifest' | 'unavailable'
}

/**
 * Reduce install evidence to one verdict.
 *
 * {@link resolvePluginStateFromEvidence} owns the source precedence; this
 * wrapper adds the one hint it does not have — the adapter's own `entryId`,
 * which lets a row be found when its `moduleName` is a subpath the package name
 * comparison would miss.
 */
function resolveInstalledState(
  packageName: string,
  identity: PluginIdentity,
  inventory: PluginInventorySnapshot | undefined,
  dependencies: Record<string, string> | undefined,
): InstalledState {
  const state = resolvePluginStateFromEvidence({ packageName, inventory, dependencies })
  if (state.entry !== undefined || state.source === 'unavailable') return state
  const hinted = findByIdentity(inventory, identity.entryId)
  if (hinted === undefined) return state
  return { present: true, entry: hinted, source: 'inventory' }
}

/** Find the inventory row the adapter named by id, when it named one. */
function findByIdentity(
  inventory: PluginInventorySnapshot | undefined,
  entryId: string | undefined,
): PluginInventoryEntry | undefined {
  if (inventory === undefined || entryId === undefined) return undefined
  return inventory.entries.find((entry) => entry.entryId === entryId)
}

/** The row for this plugin: package name first, then the adapter's entry id. */
function findEntry(
  packageName: string,
  identity: PluginIdentity,
  inventory: PluginInventorySnapshot | undefined,
): PluginInventoryEntry | undefined {
  return findEntryByPackage(inventory, packageName) ?? findByIdentity(inventory, identity.entryId)
}

/** How strong install evidence from this source is. */
function installedEvidenceKind(source: InstalledState['source']): EvidenceKind {
  switch (source) {
    case 'inventory':
    case 'manifest':
      return 'observed'
    case 'loader':
      return 'inferred'
    case 'unavailable':
      return 'unavailable'
  }
}

/** Which interface produced install evidence from this source. */
function installedSource(source: InstalledState['source']): EvidenceSource {
  switch (source) {
    case 'inventory':
    case 'loader':
      return 'live_host'
    case 'manifest':
      return 'local_metadata'
    case 'unavailable':
      return 'fallback'
  }
}
