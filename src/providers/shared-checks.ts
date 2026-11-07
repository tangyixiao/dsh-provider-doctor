/**
 * The three checks every provider answers the same way, from `ctx.llm`.
 *
 * Only the `llm` service can answer "is a route registered", "is that route
 * configurable" and "what does it offer". Each provider adapter supplies its own
 * credential and diagnostic evidence, because only it knows which CLI to run.
 *
 * The distinction this module keeps sharp:
 *
 * - **registered** — `llm.listProviders()` returned the id. That is the only
 *   authoritative answer, because it reflects the adapter table of *this*
 *   process, not a file.
 * - **configurable** — `llm.listConfigurableProviders()` returned an entry. A
 *   route can be registered without being in the directory; that is a degraded
 *   configuration surface, not a broken provider, so it warns.
 * - **catalog** — `llm.listModels()` answered. An empty answer is a real failure:
 *   a registered provider with no models cannot serve a request.
 *
 * Nothing here calls `llm.discoverModels`: that interface may reach the network
 * with a live credential, which the doctor never does on its own initiative.
 *
 * @module dsh-provider-doctor/providers/shared-checks
 */

import type { CheckResult } from '../shared/contract.ts'
import { fail, notChecked, pass, unknown, warn } from '../shared/check-helpers.ts'
import { describeError } from '../shared/check-helpers.ts'
import type { ConfigurableProviderLike, LlmLike } from './types.ts'

/** Every check in this file is an in-process read. */
const OFFLINE = 'offline' as const

/** The maximum number of model ids quoted into a detail object. */
const MODEL_SAMPLE_SIZE = 8

/** What the registration check needs. */
export interface RegistrationInput {
  /** The `llm` service, when this host mounted one. */
  llm: LlmLike | undefined
  /** The provider id whose route should exist. */
  providerId: string
  /** The plugin package that is supposed to register it, for the copy. */
  pluginName: string
}

/**
 * Report whether a route adapter is registered for this provider.
 *
 * @param input - The live `llm` service and the id to look for.
 * @returns `pass` registered, `fail` absent, `unknown` when `llm` is missing.
 */
export function providerRegisteredCheck(input: RegistrationInput): CheckResult {
  if (input.llm === undefined) {
    return unknown({
      id: 'provider-registered',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: OFFLINE,
      reasonCode: 'llm_unavailable',
      summary: 'This host exposes no model-provider service, so no route table could be read.',
      nextSteps: ['Run the diagnosis from the DSH Web or Desktop app, which mounts the model service.'],
      details: { provider: input.providerId },
    })
  }

  let providers: { id: string; name: string }[]
  try {
    providers = input.llm.listProviders()
  } catch (error) {
    return unknown({
      id: 'provider-registered',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'llm_unavailable',
      summary: 'The model-provider service refused to list its routes.',
      nextSteps: ['Reload DSH, then run the diagnosis again.'],
      details: { provider: input.providerId, error: describeError(error) },
    })
  }

  const found = providers.find((provider) => provider.id === input.providerId)
  if (found === undefined) {
    return fail({
      id: 'provider-registered',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'provider_not_registered',
      summary: `No route adapter is registered for "${input.providerId}", so a request to it cannot be served.`,
      nextSteps: [
        `Confirm ${input.pluginName} is enabled and finished loading.`,
        'Reload DSH after enabling it; the adapter registers during plugin startup.',
        'If the plugin is loaded and this still fails, the provider\'s own diagnostic explains why.',
      ],
      details: { provider: input.providerId, routeCount: providers.length },
    })
  }

  return pass({
    id: 'provider-registered',
    evidenceKind: 'observed',
    source: 'live_host',
    cost: OFFLINE,
    summary: `The host has a route adapter registered for "${found.id}" (${found.name}).`,
    details: { provider: found.id, name: found.name, routeCount: providers.length },
  })
}

/**
 * Report whether the registered route also appears in the configuration directory.
 *
 * A route that is missing here still serves requests; what it loses is the
 * settings surface that lets the operator point it somewhere else. That is a
 * warning, and the check says which of the two situations it saw.
 *
 * @param input - The live `llm` service and the id to look for.
 * @returns `pass` present, `warning` registered-but-unlisted or flagged, `unknown` when unreadable.
 */
export function providerConfigurableCheck(input: Omit<RegistrationInput, 'pluginName'>): CheckResult {
  if (input.llm === undefined) {
    return unknown({
      id: 'provider-configurable',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: OFFLINE,
      reasonCode: 'llm_unavailable',
      summary: 'This host exposes no model-provider service, so the configuration directory could not be read.',
      nextSteps: ['Run the diagnosis from the DSH Web or Desktop app.'],
      details: { provider: input.providerId },
    })
  }

  let directory: ConfigurableProviderLike[]
  try {
    directory = input.llm.listConfigurableProviders()
  } catch (error) {
    return unknown({
      id: 'provider-configurable',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'llm_unavailable',
      summary: 'The model-provider service refused to list its configuration directory.',
      nextSteps: ['Reload DSH, then run the diagnosis again.'],
      details: { provider: input.providerId, error: describeError(error) },
    })
  }

  const entry = directory.find((candidate) => candidate.provider === input.providerId)
  if (entry === undefined) {
    return warn({
      id: 'provider-configurable',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'provider_not_configurable',
      summary: `"${input.providerId}" has no entry in the configuration directory, so it cannot be configured from settings.`,
      nextSteps: [
        'If a route is registered for it, requests can still be served; this only affects the settings surface.',
        'Report this to the provider plugin maintainer if the configuration page is expected.',
      ],
      details: { provider: input.providerId, directoryCount: directory.length },
    })
  }

  const details: Record<string, unknown> = {
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
  }
  if (entry.error !== undefined && entry.error !== '') {
    details['configurationError'] = entry.error
    return warn({
      id: 'provider-configurable',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'provider_not_configurable',
      summary: `"${entry.provider}" is in the configuration directory but reports a configuration problem.`,
      nextSteps: ['Open this provider in the DSH settings and correct the reported values.'],
      details,
    })
  }

  return pass({
    id: 'provider-configurable',
    evidenceKind: 'observed',
    source: 'live_host',
    cost: OFFLINE,
    summary: `"${entry.displayName}" is in the configuration directory (settings namespace "${entry.settingsNs}").`,
    details,
  })
}

/**
 * Read the provider's model catalog through the host's own adapter.
 *
 * `listModels` is answered by the plugin's adapter from data it already holds,
 * so this is an in-process read. It never asks the provider to discover models
 * over the network.
 *
 * When the caller already knows no route adapter exists, asking for a catalog
 * would produce a second failure describing the first one. That case reports
 * `not_checked` with the registration reason instead, so the report carries one
 * cause and not two symptoms of it.
 *
 * @param input - The live `llm` service, the id whose catalog to read, and what
 * the registration check already found.
 * @returns `pass` non-empty, `fail` empty, `unknown` when unreadable, or
 * `not_checked` when there is no route to read from.
 */
export async function modelCatalogCheck(input: {
  llm: LlmLike | undefined
  providerId: string
  /** `false` when the registration check proved no adapter exists. */
  registered?: boolean
}): Promise<CheckResult> {
  if (input.llm === undefined) {
    return unknown({
      id: 'model-catalog',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: OFFLINE,
      reasonCode: 'llm_unavailable',
      summary: 'This host exposes no model-provider service, so the model catalog could not be read.',
      nextSteps: ['Run the diagnosis from the DSH Web or Desktop app.'],
      details: { provider: input.providerId },
    })
  }

  if (input.registered === false) {
    return notChecked({
      id: 'model-catalog',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'provider_not_registered',
      summary: `No route adapter is registered for "${input.providerId}", so it has no model catalog to read.`,
      nextSteps: ['Fix the registration failure above; the catalog follows from it.'],
      details: { provider: input.providerId },
    })
  }

  let models: readonly { id: string; name?: string; contextWindow?: number }[]
  try {
    models = await input.llm.listModels(input.providerId)
  } catch (error) {
    return unknown({
      id: 'model-catalog',
      evidenceKind: 'unavailable',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'catalog_unreadable',
      summary: `The adapter for "${input.providerId}" rejected the catalog request.`,
      nextSteps: ['Re-run the diagnosis; if it repeats, the provider plugin needs attention.'],
      details: { provider: input.providerId, error: describeError(error) },
    })
  }

  if (models.length === 0) {
    return fail({
      id: 'model-catalog',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: OFFLINE,
      reasonCode: 'catalog_empty',
      summary: `The adapter for "${input.providerId}" reports no models, so no request can be sent.`,
      nextSteps: [
        'Sign in to the provider\'s own client, then reload DSH.',
        'Open the provider\'s configuration page and refresh its catalog.',
      ],
      details: { provider: input.providerId, modelCount: 0 },
    })
  }

  const sample = models.slice(0, MODEL_SAMPLE_SIZE).map((model) => model.id)
  const details: Record<string, unknown> = {
    provider: input.providerId,
    modelCount: models.length,
    sample,
  }
  const first = models[0]
  if (first?.contextWindow !== undefined) details['firstContextWindow'] = first.contextWindow
  return pass({
    id: 'model-catalog',
    evidenceKind: 'observed',
    source: 'live_host',
    cost: OFFLINE,
    summary: `The adapter for "${input.providerId}" offers ${models.length} model${models.length === 1 ? '' : 's'}.`,
    details,
  })
}

/**
 * Report a credential-state check the adapter did not run.
 *
 * Credential state lives behind the provider's own CLI, and starting a child
 * process is exactly what the default run must not do. The check therefore
 * reports `not_checked` with the reason that fits, and the connection check is
 * where it turns into a real answer.
 *
 * @param input - The provider this check belongs to and why it was skipped.
 * @returns A `not_checked` result, marked side-effecting so the UI discloses it.
 */
export function credentialNotChecked(input: {
  providerId: string
  /** True when the operator ran the plain diagnosis; false is not possible here. */
  connectionCheck: boolean
  detail?: Record<string, unknown>
}): CheckResult {
  const details: Record<string, unknown> = { provider: input.providerId, ...input.detail }
  return {
    id: 'credential-metadata',
    status: 'not_checked',
    evidenceKind: 'unavailable',
    observedAt: new Date().toISOString(),
    source: 'provider_diagnostic',
    cost: 'side_effecting',
    reasonCode: 'not_requested',
    summary: input.connectionCheck
      ? 'Credential state was not read even though the connection check ran.'
      : 'Credential state is only visible through the provider\'s own diagnostic, which starts a local process. Run the connection check to read it.',
    nextSteps: ['Use "Run the connection check" to include the provider\'s own diagnostic.'],
    details,
  }
}
