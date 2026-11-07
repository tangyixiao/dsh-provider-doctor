/**
 * Chain order, re-exported where the runner and the UI both import it from.
 *
 * The order is defined once in {@link ../shared/catalog.ts} beside the cost
 * table, so a check cannot be ordered without also declaring what it costs.
 *
 * @module dsh-provider-doctor/shared/chain
 */

export { CHAIN_ORDER, CHECK_CATALOG, OFFLINE_CHECKS, SIDE_EFFECTING_CHECKS } from './catalog.ts'
export type { CheckDefinition } from './catalog.ts'
