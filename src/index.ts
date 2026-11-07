/**
 * The Host half's entry point.
 *
 * This file owns composition, not evidence: it resolves the services the
 * doctor needs, registers the read-only HTTP routes the browser half calls, and
 * tears everything down with the fiber. Every fact it reports is collected by
 * {@link runDiagnostics}, which is deliberately service-free so a test can run
 * it against fabricated hosts.
 *
 * @module dsh-provider-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { PLUGIN_VERSION } from './version.ts'
import { createDiagnosticService } from './host/service.ts'
import { registerDoctorRoutes, type RouteHost } from './host/routes.ts'
import { WORKBUDDY_ADAPTERS } from './providers/workbuddy/adapter.ts'
import { ZCODE_ADAPTER } from './providers/zcode/adapter.ts'
import type { ProviderAdapter } from './providers/types.ts'

/** Cordis plugin name. */
export const name = 'dsh-provider-doctor'

/**
 * Services this Host half uses when they exist.
 *
 * `llm` and `webServer` are required for the plugin to be useful, but neither
 * is a hard dependency of the diagnosis itself: a host without `llm` still gets
 * an install/enable report with the registration link marked unknown. Both are
 * therefore read through `ctx.get(...)` rather than `inject`, so a partial host
 * degrades instead of refusing to start the plugin.
 */
export const inject = []

/** The provider adapters this version ships, in chain order. */
export const ADAPTERS: readonly ProviderAdapter[] = [...WORKBUDDY_ADAPTERS, ZCODE_ADAPTER]

/**
 * Mount the doctor.
 *
 * @param ctx - The Host context the bundle was inserted into.
 */
export function apply(ctx: Context): void {
  const service = createDiagnosticService({
    version: PLUGIN_VERSION,
    adapters: ADAPTERS,
    context: ctx,
  })

  ctx.effect(() => {
    ctx.logger?.info?.(`provider-doctor ${PLUGIN_VERSION}: ${String(ADAPTERS.length)} providers`)
    return () => {
      service.dispose()
    }
  }, 'dsh-provider-doctor: diagnostics')

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    // The bundle's own types do not declare `webServer` on Context; the service
    // is present because this callback only runs once both injections resolve.
    const webServer = (webCtx as unknown as { webServer?: { register?: unknown } }).webServer
    if (typeof webServer?.register !== 'function') return
    const dispose = registerDoctorRoutes(webCtx as unknown as RouteHost, service)
    return () => {
      dispose()
    }
  })
}

/** The Cordis service name, exported so tests and the client can name it. */
export const DIAGNOSTIC_SERVICE = 'providerDoctor'

/** Re-export the running context type for consumers building fake hosts. */
export type { Context as HostContext }
export { CordisContext }
