/**
 * The doctor's HTTP routes, mounted on the DSH host web server.
 *
 * The routes are deliberately few and all read-only in the HTTP sense: every one
 * is a `GET` that either returns the cached snapshot or runs a diagnosis whose
 * cost was disclosed before the browser asked for it. The connection check is a
 * separate route so a page cannot start a child process by refreshing.
 *
 * Route layout (namespaced by package name, the convention the host itself uses):
 *
 * - `GET  /plugins/dsh-provider-doctor/status`   — snapshot, or `{running:false, empty:true}`
 * - `POST /plugins/dsh-provider-doctor/diagnose`  — run the offline checks
 * - `POST /plugins/dsh-provider-doctor/connect`   — run the offline checks *and* the
 *   side-effecting connection check (explicitly requested by the person)
 * - `POST /plugins/dsh-provider-doctor/cancel`    — abort the in-flight run
 * - `GET  /plugins/dsh-provider-doctor/share`     — the redacted document
 *
 * A `POST` with no body is a deliberate shape: it says "do the thing" without
 * letting a caller smuggle parameters that would widen what the doctor reads.
 * The admission wrapper still requires the owner principal, so the verbs are not
 * reachable from a page the user did not authenticate to.
 *
 * @module dsh-provider-doctor/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { DiagnosticService } from './service.ts'
import { withOwnerAuth, type AuthContext } from './host-auth.ts'
import { PLUGIN_ROUTE_PREFIX } from '../shared/status-paths.ts'

/** The service provider and route table live on. */
export interface RouteHost extends AuthContext {
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
}

/** Send a JSON body with the headers every doctor response carries. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** Send 405 with the allowed verbs, matching the host's own resource policy. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow)
  sendJson(res, 405, { error: 'method-not-allowed' })
}

/**
 * Mount every doctor route.
 *
 * @param ctx - The Host context, narrowed to the web server and the connection.
 * @param service - The diagnostics service.
 * @returns A disposer for all routes, for the caller to run with its fiber.
 */
export function registerDoctorRoutes(ctx: RouteHost, service: DiagnosticService): () => void {
  const disposers: (() => void)[] = []

  const register = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    const wrapped = withOwnerAuth(ctx, handler)
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler: wrapped }))
  }

  // --- Status: cheap, always available, safe to poll -------------------------

  register(`${PLUGIN_ROUTE_PREFIX}/status`, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const snapshot = service.last()
    if (snapshot === undefined) {
      sendJson(res, 200, { schemaVersion: 1, empty: true, running: false })
      return
    }
    sendJson(res, 200, { schemaVersion: 1, empty: false, ...snapshot })
  })

  // --- Diagnose: the offline set --------------------------------------------

  register(`${PLUGIN_ROUTE_PREFIX}/diagnose`, async (req, res) => {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const snapshot = await service.diagnose()
    sendJson(res, 200, { schemaVersion: 1, empty: false, ...snapshot })
  })

  // --- Connect: the disclosed side effects ----------------------------------

  register(`${PLUGIN_ROUTE_PREFIX}/connect`, async (req, res) => {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    const snapshot = await service.diagnose({ connectionCheck: true })
    sendJson(res, 200, { schemaVersion: 1, empty: false, ...snapshot })
  })

  // --- Cancel ----------------------------------------------------------------

  register(`${PLUGIN_ROUTE_PREFIX}/cancel`, async (req, res) => {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await service.cancel()
    sendJson(res, 200, { cancelled: true })
  })

  // --- Share: the redacted document -----------------------------------------

  register(`${PLUGIN_ROUTE_PREFIX}/share`, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD')
      return
    }
    const shareable = service.shareable()
    if (shareable === undefined) {
      sendJson(res, 409, { error: 'no-report-yet' })
      return
    }
    sendJson(res, 200, shareable)
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A route already removed by its fiber is not an error here.
      }
    }
  }
}
