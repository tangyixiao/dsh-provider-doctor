/**
 * The doctor's Host-side service: one running diagnosis at a time, a kept
 * result, and a cancellation path the browser can actually reach.
 *
 * The service exists so the routes stay thin and the policy lives in one place:
 *
 * - **One run in flight.** A second "diagnose" while the first is still working
 *   joins the existing run rather than starting a competing one — two concurrent
 *   CLI launches would make the timeout budgets lie.
 * - **Last result is kept.** A page refresh re-renders from the last report
 *   instead of re-running every check, and a `not_checked` connection check
 *   stays `not_checked` until someone explicitly asks for it.
 * - **Cancellation is real.** The run's `AbortSignal` reaches every adapter, so
 *   the stopped run reports `cancelled` rather than quietly returning stale data.
 *
 * The loader snapshot is memoised per run: every adapter asks for the same plugin
 * table, and reading it once also means two adapters cannot disagree about it.
 *
 * @module dsh-provider-doctor/host/service
 */

import type { Context } from '@deepseek-ai/cordis'

import type { DiagnosticReport, ShareableReport } from '../shared/contract.ts'
import type { DoctorSnapshot } from '../shared/snapshot.ts'
import { runDiagnostics, type RunOptions, type RunResult } from './run.ts'
import { readHostFacts, discoverProfile, type HostFacts, type ProfileFacts } from './runtime.ts'
import { toShareableReport, redactText } from '../privacy/redact.ts'
import type { HostServices, PluginInventorySnapshot, ProviderAdapter } from '../providers/types.ts'

/** What the service needs at construction. */
export interface ServiceOptions {
  /** This plugin's own version, used in shareable reports. */
  version: string
  /** Which adapters to run. */
  adapters: readonly ProviderAdapter[]
  /** The Host context, read for its optional services. */
  context: Context
  /**
   * Where the live host facts and profile come from. Production leaves this
   * out and the real discovery runs; tests inject a fixed pair so the service's
   * own policies — single flight, cancellation, the kept result — can be
   * exercised without depending on the machine the suite happens to run on.
   */
  locate?: () => { hostFacts: HostFacts; profile: ProfileFacts }
}

/** The diagnostics service the routes call. */
export interface DiagnosticService {
  /** Run (or join) a diagnosis and return the snapshot it produced. */
  diagnose(options?: RunOptions): Promise<DoctorSnapshot>
  /** The most recent snapshot, or `undefined` before the first run. */
  last(): DoctorSnapshot | undefined
  /** Cancel the in-flight run. Resolves once the run settled. */
  cancel(): Promise<void>
  /** Build the shareable document from the last snapshot. */
  shareable(): ShareableReport | undefined
  /** Release anything the service holds. */
  dispose(): void
}

/** Read the optional host services as the narrow slices the adapters use. */
function hostServices(context: Context): HostServices {
  const services: {
    llm?: unknown
    pluginInventory?: unknown
    loader?: unknown
  } = {
    llm: context.get('llm'),
    pluginInventory: context.get('pluginInventory'),
    loader: context.get('loader'),
  }
  const out: Record<string, unknown> = {}
  if (services.llm !== undefined) out['llm'] = services.llm
  if (services.pluginInventory !== undefined) out['pluginInventory'] = services.pluginInventory
  if (services.loader !== undefined) out['loader'] = services.loader
  return out as HostServices
}

/**
 * Wrap the live inventory service so every adapter sees one stable snapshot.
 *
 * The *promise* is cached, not the value: adapters run concurrently, and a
 * value cache lets every one of them race past the empty slot and read the
 * live table independently — which defeats the point of memoising it, and lets
 * two reports describe different loader states.
 *
 * A failure reading the inventory is not cached: the next adapter, or the next
 * run, should be able to try again rather than inherit one transient error.
 *
 * @param live - The host's inventory service, when mounted.
 * @returns A service-shaped wrapper, or `undefined` when the host has none.
 */
function memoiseInventory(live: HostServices['pluginInventory']): HostServices['pluginInventory'] {
  if (live === undefined) return undefined
  let cached: Promise<PluginInventorySnapshot> | undefined
  return {
    list() {
      if (cached !== undefined) return cached
      const reading = live.list()
      cached = reading
      reading.catch(() => {
        // Drop a failed read so the next caller retries instead of inheriting it.
        if (cached === reading) cached = undefined
      })
      return reading
    },
  }
}

/** Read the live host facts and the profile that is actually running. */
function locateLive(): { hostFacts: HostFacts; profile: ProfileFacts } {
  const hostFacts = readHostFacts()
  return { hostFacts, profile: discoverProfile(hostFacts.dshHome) }
}

/** Build the service. */
export function createDiagnosticService(options: ServiceOptions): DiagnosticService {
  let lastSnapshot: DoctorSnapshot | undefined
  let inFlight: { promise: Promise<DoctorSnapshot>; controller: AbortController } | undefined
  let disposed = false

  async function runOnce(runOptions: RunOptions | undefined, controller: AbortController): Promise<DoctorSnapshot> {
    const located = options.locate?.() ?? locateLive()
    const hostFacts = located.hostFacts
    const profile = located.profile
    const base = hostServices(options.context)
    const host: HostServices = {
      ...base.llm === undefined ? {} : { llm: base.llm },
      ...base.loader === undefined ? {} : { loader: base.loader },
      ...(() => {
        const inventory = memoiseInventory(base.pluginInventory)
        return inventory === undefined ? {} : { pluginInventory: inventory }
      })(),
    }

    let result: RunResult
    try {
      result = await runDiagnostics({
        adapters: options.adapters,
        host,
        hostFacts,
        profile,
        dshHome: hostFacts.dshHome,
        ...runOptions === undefined ? {} : { options: runOptions },
        signal: controller.signal,
      })
    } catch (error) {
      // runDiagnostics is total by construction; this is a last-resort guard so
      // the route returns a snapshot-shaped result instead of an empty 500.
      result = {
        reports: [],
        failures: [{
          provider: 'all',
          message: redactText(error instanceof Error ? error.message : 'unknown error'),
        }],
      }
    }

    const snapshot: DoctorSnapshot = {
      observedAt: new Date().toISOString(),
      host: hostFacts,
      profile,
      reports: result.reports,
      failures: result.failures,
      connectionCheck: runOptions?.connectionCheck ?? false,
      running: false,
    }
    lastSnapshot = snapshot
    return snapshot
  }

  return {
    diagnose(runOptions) {
      if (disposed) return Promise.reject(new Error('provider-doctor: service disposed'))
      if (inFlight !== undefined) return inFlight.promise
      const controller = new AbortController()
      const promise = runOnce(runOptions, controller).finally(() => {
        if (inFlight?.controller === controller) inFlight = undefined
      })
      inFlight = { promise, controller }
      return promise
    },

    last() {
      return lastSnapshot
    },

    async cancel() {
      const active = inFlight
      if (active === undefined) return
      active.controller.abort()
      try {
        await active.promise
      } catch {
        // A cancelled run may reject; the caller only needs it to be over.
      }
    },

    shareable() {
      if (lastSnapshot === undefined) return undefined
      return toShareableReport(lastSnapshot.reports, {
        version: options.version,
        runtime: process.version,
        platform: process.platform,
        architecture: process.arch,
      })
    },

    dispose() {
      disposed = true
      inFlight?.controller.abort()
      inFlight = undefined
    },
  }
}
