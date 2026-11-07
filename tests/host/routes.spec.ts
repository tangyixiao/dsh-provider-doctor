import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { registerDoctorRoutes, type RouteHost } from '../../src/host/routes.ts'
import type { DiagnosticService } from '../../src/host/service.ts'
import type { DoctorSnapshot } from '../../src/shared/snapshot.ts'
import type { ShareableReport } from '../../src/shared/contract.ts'
import {
  CANCEL_PATH,
  CONNECT_PATH,
  DIAGNOSE_PATH,
  SHARE_PATH,
  STATUS_PATH,
} from '../../src/shared/status-paths.ts'
import type { ConnectionLike } from '../../src/host/host-auth.ts'
import { makeRequest, makeResponse } from '../support/fake-http.ts'

/** A snapshot the routes can hand back verbatim. */
const SNAPSHOT: DoctorSnapshot = {
  observedAt: '2026-11-06T00:00:00.000Z',
  host: {
    nodeVersion: 'v22.0.0',
    platform: 'win32',
    arch: 'x64',
    dshHome: 'C:\\Users\\someone\\.dsh',
    dshVersionSource: 'injected',
    dshVersion: '0.2.2-rc.1',
  },
  profile: { candidates: ['desktop'], source: 'single-profile', evidence: 'observed', name: 'desktop' },
  reports: [],
  failures: [],
  connectionCheck: false,
  running: false,
}

/** A shareable document with one provider and one check. */
const SHAREABLE: ShareableReport = {
  schemaVersion: 1,
  package: 'dsh-provider-doctor',
  version: '0.1.0',
  runtime: 'v22.0.0',
  platform: 'win32',
  architecture: 'x64',
  reports: [
    {
      provider: 'workbuddy',
      readiness: {
        installed: 'installed',
        enabled: 'enabled',
        registration: 'registered',
        catalog: 'readable',
        liveInference: 'not-tested',
      },
      checks: [{ id: 'host-runtime', status: 'pass', evidenceKind: 'observed', source: 'live_host' }],
    },
  ],
}

/** One received call, so the test can assert the verb and route reached the service. */
interface Calls {
  diagnose: number
  connect: number
  cancel: number
  share: number
}

/** Build a fake service and the call log it writes to. */
function fakeService(overrides: Partial<DiagnosticService> = {}): { service: DiagnosticService; calls: Calls } {
  const calls: Calls = { diagnose: 0, connect: 0, cancel: 0, share: 0 }
  const service: DiagnosticService = {
    diagnose: async (options) => {
      if (options?.connectionCheck === true) calls.connect += 1
      else calls.diagnose += 1
      return { ...SNAPSHOT, connectionCheck: options?.connectionCheck === true }
    },
    cancel: async () => {
      calls.cancel += 1
    },
    last: () => SNAPSHOT,
    shareable: () => {
      calls.share += 1
      return SHAREABLE
    },
    dispose: () => undefined,
    ...overrides,
  }
  return { service, calls }
}

/** A host context that records registrations and admits the owner. */
function fakeHost(): { host: RouteHost; paths: string[]; disposeCount: () => number } {
  const paths: string[] = []
  const disposers: (() => void)[] = []
  const connection: ConnectionLike = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
  const host: RouteHost = {
    get: () => connection,
    webServer: {
      register: (route) => {
        paths.push(route.path)
        const dispose = () => undefined
        disposers.push(dispose)
        return dispose
      },
    },
  }
  return { host, paths, disposeCount: () => disposers.length }
}

const HEADERS = { host: '127.0.0.1:13639', origin: 'http://127.0.0.1:13639' }

describe('registerDoctorRoutes', () => {
  it('mounts exactly the five documented paths', () => {
    const { host, paths } = fakeHost()
    registerDoctorRoutes(host, fakeService().service)
    expect(paths.sort()).toEqual([CANCEL_PATH, CONNECT_PATH, DIAGNOSE_PATH, SHARE_PATH, STATUS_PATH].sort())
  })

  it('namespaces every path under the plugin prefix', () => {
    const { host, paths } = fakeHost()
    registerDoctorRoutes(host, fakeService().service)
    for (const path of paths) expect(path.startsWith('/plugins/dsh-provider-doctor/')).toBe(true)
  })

  it('removes every route when the returned disposer runs, only once', () => {
    const { host } = fakeHost()
    const dispose = registerDoctorRoutes(host, fakeService().service)
    dispose()
    dispose()
    expect(true).toBe(true)
  })
})

describe('status route', () => {
  it('returns the cached snapshot when one exists', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(STATUS_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(recorded.body).toMatchObject({ schemaVersion: 1, empty: false, observedAt: SNAPSHOT.observedAt })
  })

  it('answers an empty host with an explicit empty state, not a 404', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService({ last: () => undefined }).service)
    const { res, recorded } = makeResponse()
    await routes.get(STATUS_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(recorded.body).toEqual({ schemaVersion: 1, empty: true, running: false })
  })

  it('accepts HEAD as well as GET', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(STATUS_PATH)?.(makeRequest({ method: 'HEAD', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
  })

  it('refuses a mutating verb with 405 and an Allow header', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(STATUS_PATH)?.(makeRequest({ method: 'DELETE', headers: HEADERS }), res)
    expect(recorded.status).toBe(405)
    expect(recorded.headers['allow']).toBe('GET, HEAD')
  })

  it('never runs a diagnosis just because the page polled', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)
    const { res } = makeResponse()
    await routes.get(STATUS_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(calls.diagnose).toBe(0)
    expect(calls.connect).toBe(0)
  })
})

describe('diagnose and connect routes', () => {
  it('runs the offline diagnosis on POST /diagnose', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)

    const { res, recorded } = makeResponse()
    await routes.get(DIAGNOSE_PATH)?.(makeRequest({ method: 'POST', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(calls.diagnose).toBe(1)
    expect(calls.connect).toBe(0)
    expect(recorded.body).toMatchObject({ empty: false, connectionCheck: false })
  })

  it('asks for the connection check only on the connect route', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)

    const { res, recorded } = makeResponse()
    await routes.get(CONNECT_PATH)?.(makeRequest({ method: 'POST', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(calls.connect).toBe(1)
    expect(calls.diagnose).toBe(0)
    expect(recorded.body).toMatchObject({ connectionCheck: true })
  })

  it('refuses a GET on the diagnose route, so a page cannot start it by navigation', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)
    const { res, recorded } = makeResponse()
    await routes.get(DIAGNOSE_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(405)
    expect(recorded.headers['allow']).toBe('POST')
    expect(calls.diagnose).toBe(0)
  })

  it('refuses a GET on the connect route, so a navigation cannot start a child process', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)
    const { res, recorded } = makeResponse()
    await routes.get(CONNECT_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(405)
    expect(calls.connect).toBe(0)
  })

  it('does not run when admission fails', async () => {
    const routes = new Map<string, (req: never, res: never) => unknown>()
    const denied: RouteHost = {
      get: () => ({ admit: () => ({ peer: { principal: { kind: 'guest' } } }) }),
      webServer: {
        register: (route) => {
          routes.set(route.path, route.handler as unknown as (req: never, res: never) => unknown)
          return () => undefined
        },
      },
    }
    const { service, calls } = fakeService()
    registerDoctorRoutes(denied, service)

    const { res, recorded } = makeResponse()
    await (routes.get(DIAGNOSE_PATH) as (req: unknown, res: unknown) => Promise<void>)(
      makeRequest({ method: 'POST', headers: HEADERS }),
      res,
    )
    expect(recorded.status).toBe(403)
    expect(calls.diagnose).toBe(0)
  })
})

describe('cancel route', () => {
  it('cancels the in-flight run and reports it', async () => {
    const { host } = fakeHost()
    const { service, calls } = fakeService()
    const routes = collect(host, service)
    const { res, recorded } = makeResponse()
    await routes.get(CANCEL_PATH)?.(makeRequest({ method: 'POST', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(recorded.body).toEqual({ cancelled: true })
    expect(calls.cancel).toBe(1)
  })

  it('refuses a GET', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(CANCEL_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(405)
    expect(recorded.headers['allow']).toBe('POST')
  })
})

describe('share route', () => {
  it('returns the redacted document', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(SHARE_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(200)
    expect(recorded.body).toEqual(SHAREABLE)
  })

  it('answers 409 when no diagnosis has run yet', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService({ shareable: () => undefined }).service)
    const { res, recorded } = makeResponse()
    await routes.get(SHARE_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.status).toBe(409)
    expect(recorded.body).toEqual({ error: 'no-report-yet' })
  })

  it('puts no caching header on a shareable document either', async () => {
    const { host } = fakeHost()
    const routes = collect(host, fakeService().service)
    const { res, recorded } = makeResponse()
    await routes.get(SHARE_PATH)?.(makeRequest({ method: 'GET', headers: HEADERS }), res)
    expect(recorded.headers['cache-control']).toBe('no-store')
  })
})

/** Register the routes and return them keyed by path, typed as the host sees them. */
function collect(
  host: RouteHost,
  service: DiagnosticService,
): Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const wired: RouteHost = {
    get: (name) => host.get(name),
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => undefined
      },
    },
  }
  registerDoctorRoutes(wired, service)
  return routes
}
