/**
 * Owner-only admission for the doctor's HTTP routes.
 *
 * The Host web server has no server-wide authentication policy: each route
 * owner enforces its own. This module is that policy for the doctor, and it is
 * intentionally strict — the doctor reads plugin inventories, profile paths and
 * credential *metadata*, so a route reachable by anything other than the local
 * signed-in owner would be a disclosure bug rather than a convenience.
 *
 * Three gates, in order:
 *
 * 1. **Origin.** When the browser sends an `Origin`, it must be loopback: this
 *    blocks a page on the open internet from driving the local doctor through
 *    the user's browser.
 * 2. **Host.** The `Host` header must name a loopback authority, so a rebound
 *    DNS name cannot reach the port.
 * 3. **Principal.** The connection service must admit the request as the
 *    `owner` principal. An unauthenticated or foreign caller gets 401/403.
 *
 * Every response, including errors, is `no-store`: a cached diagnosis would
 * outlive the credential it described.
 *
 * @module dsh-provider-doctor/host/host-auth
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'

/** The narrowly-typed slice of the `connection` service used here. */
export interface ConnectionLike {
  admit(request: IncomingMessage):
    | { peer: { principal: { kind: string } } }
    | { rejection: 401 | 403 }
}

/** The slice of the Host context this module reads. */
export interface AuthContext {
  get(service: 'connection'): ConnectionLike | undefined
}

/** A JSON response writer that never leaks a body on a rejected request. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Why a request was refused, or `undefined` when it should proceed.
 *
 * Exported so a test can assert each gate without standing up a server.
 *
 * @param req - The incoming request.
 * @param connection - The connection service, when the host provides one.
 * @returns The status to refuse with, or `undefined` to proceed.
 */
export function refusalFor(req: IncomingMessage, connection: ConnectionLike | undefined): 401 | 403 | undefined {
  if (!hostIsLoopback(req.headers.host)) return 403
  if (!originIsLoopback(req.headers.origin)) return 403
  if (connection === undefined) return 401
  const admission = connection.admit(req)
  if ('rejection' in admission) return admission.rejection
  return admission.peer.principal.kind === 'owner' ? undefined : 403
}

/**
 * Wrap a handler with the doctor's admission policy.
 *
 * The handler is only called once every gate passed, so it may assume an
 * owner-authenticated loopback request. Verb checking is the caller's job: the
 * doctor has one read-only `GET` family and one explicit `POST` family, and a
 * shared gate here would have to know which route is which.
 *
 * @param ctx - The Host context (read for the `connection` service).
 * @param handler - The real route body.
 * @returns A Node request handler.
 */
export function withOwnerAuth(
  ctx: AuthContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const connection = ctx.get('connection')
    const refusal = refusalFor(req, connection)
    if (refusal !== undefined) {
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, refusal, { error: refusal === 401 ? 'unauthorized' : 'forbidden' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, 500, { error: 'internal-error', message: messageOf(error) })
    }
  }
}

/** A short, redaction-safe description of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return 'unknown error'
}
