import { describe, expect, it } from 'vitest'

import { refusalFor, withOwnerAuth, type ConnectionLike } from '../../src/host/host-auth.ts'
import { makeRequest, makeResponse } from '../support/fake-http.ts'

/** A connection service that admits the owner. */
const OWNER: ConnectionLike = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }

/** A connection service that admits a non-owner principal. */
const GUEST: ConnectionLike = { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }

/** A connection service that rejects outright. */
const REJECTING: ConnectionLike = { admit: () => ({ rejection: 401 as const }) }

/** A request the host itself would make from its own page. */
function loopbackRequest(overrides: { host?: string; origin?: string } = {}) {
  return makeRequest({
    method: 'GET',
    headers: {
      host: overrides.host ?? '127.0.0.1:13639',
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    },
  })
}

describe('refusalFor', () => {
  it('admits an owner request from a loopback page', () => {
    expect(refusalFor(loopbackRequest({ origin: 'http://127.0.0.1:13639' }), OWNER)).toBeUndefined()
  })

  it('admits a request with no Origin header at all', () => {
    expect(refusalFor(loopbackRequest(), OWNER)).toBeUndefined()
  })

  it('refuses a non-loopback Host, so a rebound name cannot reach the port', () => {
    expect(refusalFor(loopbackRequest({ host: 'evil.example:13639' }), OWNER)).toBe(403)
  })

  it('refuses a cross-site Origin even from a loopback Host', () => {
    expect(refusalFor(loopbackRequest({ origin: 'https://evil.example' }), OWNER)).toBe(403)
  })

  it('refuses an opaque Origin', () => {
    expect(refusalFor(loopbackRequest({ origin: 'null' }), OWNER)).toBe(403)
  })

  it('reports unauthorized when the host has no connection service', () => {
    expect(refusalFor(loopbackRequest(), undefined)).toBe(401)
  })

  it('passes through the rejection the connection chose', () => {
    expect(refusalFor(loopbackRequest(), REJECTING)).toBe(401)
  })

  it('refuses a principal that is not the owner', () => {
    expect(refusalFor(loopbackRequest(), GUEST)).toBe(403)
  })
})

describe('withOwnerAuth', () => {
  it('runs the handler only after admission', async () => {
    const { res, recorded } = makeResponse()
    let ran = false
    const handler = withOwnerAuth({ get: () => OWNER }, (_req, response) => {
      ran = true
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ok":true}')
    })
    await handler(loopbackRequest(), res)
    expect(ran).toBe(true)
    expect(recorded.status).toBe(200)
    expect(recorded.body).toEqual({ ok: true })
  })

  it('never calls the handler when admission fails', async () => {
    const { res, recorded } = makeResponse()
    const handler = withOwnerAuth({ get: () => GUEST }, () => {
      throw new Error('must not run')
    })
    await handler(loopbackRequest(), res)
    expect(recorded.status).toBe(403)
    expect(recorded.body).toEqual({ error: 'forbidden' })
  })

  it('never calls the handler when the connection service is absent', async () => {
    const { res, recorded } = makeResponse()
    const handler = withOwnerAuth({ get: () => undefined }, () => {
      throw new Error('must not run')
    })
    await handler(loopbackRequest(), res)
    expect(recorded.status).toBe(401)
    expect(recorded.body).toEqual({ error: 'unauthorized' })
  })

  it('marks every response no-store, including refusals', async () => {
    const denied = makeResponse()
    await withOwnerAuth({ get: () => GUEST }, () => undefined)(loopbackRequest(), denied.res)
    expect(denied.recorded.headers['cache-control']).toBe('no-store')

    const allowed = makeResponse()
    await withOwnerAuth({ get: () => OWNER }, (_req, response) => {
      response.end('done')
    })(loopbackRequest(), allowed.res)
    expect(allowed.recorded.headers['cache-control']).toBe('no-store')
  })

  it('turns a thrown handler into a JSON 500 rather than a dropped socket', async () => {
    const { res, recorded } = makeResponse()
    await withOwnerAuth({ get: () => OWNER }, () => {
      throw new Error('route exploded')
    })(loopbackRequest(), res)
    expect(recorded.status).toBe(500)
    expect(recorded.body).toEqual({ error: 'internal-error', message: 'route exploded' })
  })

  it('ends the response instead of writing a second body once headers are out', async () => {
    const { res, recorded } = makeResponse()
    await withOwnerAuth({ get: () => OWNER }, (_req, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      throw new Error('late failure')
    })(loopbackRequest(), res)
    expect(recorded.status).toBe(200)
    expect(recorded.ended).toBe(true)
  })

  it('describes a non-Error throw without pretending to know its message', async () => {
    const { res, recorded } = makeResponse()
    await withOwnerAuth({ get: () => OWNER }, () => {
      throw 'a string, not an error'
    })(loopbackRequest(), res)
    expect(recorded.status).toBe(500)
    expect(recorded.body).toEqual({ error: 'internal-error', message: 'unknown error' })
  })
})
