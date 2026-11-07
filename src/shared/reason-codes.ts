/**
 * The closed reason-code vocabulary.
 *
 * Every non-passing check names one of these codes. Codes are stable strings
 * because they are the only machine-readable fact that reaches a shared
 * report: the UI translates them, the shareable report carries them verbatim.
 * A code that is not in this table must never enter a report — an unexpected
 * condition becomes {@link REASON_CODES.internal_error}, and the operator still
 * gets a next step.
 *
 * @module dsh-provider-doctor/shared/reason-codes
 */

/** Every reason code this version can emit. */
export const REASON_CODES = {
  /** No DSH runtime version could be read from this process. */
  host_version_unreadable: 'host_version_unreadable',
  /** The running DSH build is outside the range this plugin was verified against. */
  host_version_mismatch: 'host_version_mismatch',
  /** No profile directory could be located for the running host. */
  profile_unresolved: 'profile_unresolved',

  /** The provider's plugin package is not in the profile's dependency records. */
  plugin_missing: 'plugin_missing',
  /** The plugin is installed but disabled, so its provider route cannot exist. */
  plugin_disabled: 'plugin_disabled',
  /** The plugin's loader entry failed to start; its diagnostic carries the cause. */
  plugin_failed: 'plugin_failed',
  /** The plugin is installed but not present in the live loader snapshot. */
  plugin_not_loaded: 'plugin_not_loaded',
  /** The inventory gateway is absent (headless composition), so install state is unknown. */
  inventory_unavailable: 'inventory_unavailable',

  /** No adapter is registered for this provider route in the running host. */
  provider_not_registered: 'provider_not_registered',
  /** The route is registered but not in the configurable directory. */
  provider_not_configurable: 'provider_not_configurable',
  /** The `llm` service itself is unavailable in this host. */
  llm_unavailable: 'llm_unavailable',

  /** The provider plugin's own diagnostic entry point is not installed. */
  diagnostic_cli_missing: 'diagnostic_cli_missing',
  /** The diagnostic ran but reported a credential problem. */
  credential_missing: 'credential_missing',
  /** The diagnostic ran but reported the stored credential unreadable. */
  credential_unreadable: 'credential_unreadable',
  /** The stored credential names a different region than the provider expects. */
  credential_region_mismatch: 'credential_region_mismatch',
  /** The diagnostic reported a sign-out state without a more specific cause. */
  signed_out: 'signed_out',

  /** The CLI the plugin needs (ZCode desktop) could not be located. */
  cli_missing: 'cli_missing',
  /** The CLI path exists but its runtime metadata could not be read. */
  cli_runtime_unreadable: 'cli_runtime_unreadable',
  /** The diagnostic executable exists but cannot resolve a module it imports. */
  diagnostic_cli_unloadable: 'diagnostic_cli_unloadable',

  /** `llm.listModels` returned an empty catalog. */
  catalog_empty: 'catalog_empty',
  /** `llm.listModels` rejected or threw. */
  catalog_unreadable: 'catalog_unreadable',
  /** The catalog check was skipped because a prior link is already broken. */
  catalog_dependency_failed: 'catalog_dependency_failed',

  /** The check exceeded its own budget. */
  timed_out: 'timed_out',
  /** The person cancelled the run while this check was pending. */
  cancelled: 'cancelled',
  /** No request has been recorded for this provider yet. */
  no_recorded_attempt: 'no_recorded_attempt',
  /** The recorded request outcomes exist but could not be parsed. */
  probe_store_unreadable: 'probe_store_unreadable',
  /** A request was recorded, but it left the question undecided. */
  inconclusive_probe: 'inconclusive_probe',
  /** The recorded attempt was refused for the settings being requested. */
  model_rejected_reasoning: 'model_rejected_reasoning',

  /** The check was not requested (side-effecting checks default to this). */
  not_requested: 'not_requested',
  /** An unexpected error was caught; its message is redacted before display. */
  internal_error: 'internal_error',
  /** The evidence source does not expose this fact. */
  unsupported: 'unsupported',
} as const

/** One reason code. */
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES]

/** Every reason code, as a Set, for validation at the report boundary. */
export const REASON_CODE_SET: ReadonlySet<string> = new Set(Object.values(REASON_CODES))

/** Was this string a known reason code? */
export function isReasonCode(value: string): value is ReasonCode {
  return REASON_CODE_SET.has(value)
}
