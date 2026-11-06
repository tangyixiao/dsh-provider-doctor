/**
 * What the doctor can ask of one provider adapter.
 *
 * An adapter never decides policy: it collects evidence for the checks it
 * owns and returns them in chain order. Everything it returns must already be
 * redacted, because the Host half hands these objects straight to the browser
 * and to the shareable report builder.
 *
 * @module dsh-provider-doctor/providers/types
 */

import type { CheckResult, ProviderId } from '../shared/contract.ts'

/** The provider plugin's own identity, as installed in this profile. */
export interface PluginIdentity {
  /** npm package name that owns the provider route. */
  name: string
  /** Loaded version when the inventory or manifest made it readable. */
  version?: string
  /** Cordis entry id inside the profile, when the inventory exposed one. */
  entryId?: string
}

/** Everything an adapter may read. Handed in, never fetched by the adapter. */
export interface AdapterContext {
  /** Live DSH services, each optional: a headless host may lack several. */
  host: HostServices
  /** Absolute DSH home directory the evidence came from. */
  dshHome: string
  /** Absolute profile directory that is running, when known. */
  profileDir?: string
  /** Cancellation for the whole run. */
  signal: AbortSignal
  /** Per-check budget in milliseconds. */
  budgetMs: number
  /** Run the side-effecting connection check instead of reporting `not_checked`. */
  connectionCheck: boolean
}

/** The DSH services this plugin consumes, typed as narrowly as it uses them. */
export interface HostServices {
  /** `llm` — provider routes and model catalogs. */
  llm?: LlmLike
  /** `pluginInventory` — read-only loader snapshot. */
  pluginInventory?: { list(): Promise<PluginInventorySnapshot> }
  /** `loader` — the entry table, when the inventory gateway is absent. */
  loader?: { entries(): Iterable<LoaderEntryLike> }
}

/** The slice of `ctx.llm` this plugin calls. */
export interface LlmLike {
  listProviders(): { id: string; name: string }[]
  listConfigurableProviders(): ConfigurableProviderLike[]
  listModels(provider: string): Promise<readonly ModelInfoLike[]>
}

/** The slice of one configurable provider entry this plugin reads. */
export interface ConfigurableProviderLike {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath?: string[]
  defaultBaseURL?: string
  baseURLEnv?: string[]
  error?: string
}

/** The slice of one model description this plugin reads. */
export interface ModelInfoLike {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

/** The slice of the plugin inventory snapshot this plugin reads. */
export interface PluginInventorySnapshot {
  managementAvailable?: boolean
  entries: PluginInventoryEntry[]
}

/** One loader entry as the inventory reports it. */
export interface PluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: null | 'failed' | 'active' | 'pending' | 'loading' | 'unloading'
  diagnostic?: string
  meta?: { title?: string; description?: string; icon?: string; error?: string }
}

/** The loader entry shape used only when the inventory gateway is missing. */
export interface LoaderEntryLike {
  options?: { id?: string; name?: string; group?: boolean }
  disabled?: boolean
  fiber?: { state?: number }
}

/** One provider adapter. */
export interface ProviderAdapter {
  /** Which provider this adapter diagnoses. */
  readonly id: ProviderId
  /** Human-facing name, untranslated (the client localizes its own copy). */
  readonly displayName: string
  /** The plugin package that owns this provider route. */
  readonly pluginName: string
  /** Which checks this adapter can produce, in chain order. */
  readonly checks: readonly string[]
  /** Collect every check. Must never throw; failures become `unknown` results. */
  diagnose(context: AdapterContext): Promise<CheckResult[]>
}
