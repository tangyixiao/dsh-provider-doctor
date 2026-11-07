/**
 * The chain order and the check catalog.
 *
 * These two tables are the single source of truth for "what the doctor asks, in
 * what order, and what it costs". The Host half uses them to order results; the
 * browser half uses them to render the chain before any check has run; the
 * disclosure text before a connection check is generated from the same table.
 * Duplicating this knowledge anywhere else is how a UI ends up advertising a
 * cost the Host does not charge.
 *
 * @module dsh-provider-doctor/shared/catalog
 */

import type { CheckCost, CheckId } from './contract.ts'

/**
 * The chain order, outermost link first.
 *
 * This is the diagnostic story the plan asks the page to tell: is DSH itself
 * the right build, is there a profile, is the plugin installed, is it enabled,
 * is a route registered, is that route configurable, is there credential
 * metadata, is the catalog readable, did the provider's own diagnostic agree,
 * and what did the last error say.
 */
export const CHAIN_ORDER: readonly CheckId[] = [
  'host-runtime',
  'profile-identity',
  'plugin-installed',
  'plugin-enabled',
  'provider-registered',
  'provider-configurable',
  'credential-metadata',
  'model-catalog',
  'provider-diagnostic',
  'recent-error',
]

/** One check's static description. */
export interface CheckDefinition {
  /** Stable id, also the translation key suffix. */
  id: CheckId
  /** What running it costs. */
  cost: CheckCost
  /** Whether the browser half may request it individually. */
  requestable: boolean
}

/** Every check this version knows, keyed by id. */
export const CHECK_CATALOG: Readonly<Record<CheckId, CheckDefinition>> = Object.freeze({
  'host-runtime': { id: 'host-runtime', cost: 'offline', requestable: true },
  'profile-identity': { id: 'profile-identity', cost: 'offline', requestable: true },
  'plugin-installed': { id: 'plugin-installed', cost: 'offline', requestable: true },
  'plugin-enabled': { id: 'plugin-enabled', cost: 'offline', requestable: true },
  'provider-registered': { id: 'provider-registered', cost: 'offline', requestable: true },
  'provider-configurable': { id: 'provider-configurable', cost: 'offline', requestable: true },
  // Credential state is only visible through the provider plugin's own CLI: the
  // doctor refuses to read a credential file itself, so this check is a child
  // process and therefore not part of the default run.
  'credential-metadata': { id: 'credential-metadata', cost: 'side_effecting', requestable: true },
  'model-catalog': { id: 'model-catalog', cost: 'offline', requestable: true },
  'provider-diagnostic': { id: 'provider-diagnostic', cost: 'side_effecting', requestable: true },
  'recent-error': { id: 'recent-error', cost: 'offline', requestable: true },
})

/**
 * The checks a plain "run the diagnosis" press performs.
 *
 * Side-effecting checks are absent: the plan requires an explicit, separate
 * confirmation for anything that starts a process or uses a signed-in session.
 */
export const OFFLINE_CHECKS: readonly CheckId[] = CHAIN_ORDER.filter(
  (id): boolean => CHECK_CATALOG[id].cost === 'offline',
)

/** The side-effecting checks, listed in the disclosure before they run. */
export const SIDE_EFFECTING_CHECKS: readonly CheckId[] = CHAIN_ORDER.filter(
  (id): boolean => CHECK_CATALOG[id].cost === 'side_effecting',
)
