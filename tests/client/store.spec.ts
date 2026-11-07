import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPanelStore } from '../../src/client/store.ts'
import type { DoctorSnapshot } from '../../src/shared/snapshot.ts'

/** A snapshot the Host could have produced. */
function snapshot(overrides: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return {
    observedAt: '2026-11-07T00:00:00.000Z',
    host: {
      dshVersion: '0.2.2-rc.1',
      dshVersionSource: 'package-manifest',
      nodeVersion: 'v24.21.0',
      platform: 'win32',
      arch: 'x64',
      dshHome: 'C:\\Users\\someone\\.dsh',
    },
    profile: { name: 'desktop', dir: 'C:\\Users\\someone\\.dsh\\profiles\\desktop', candidates: ['desktop'], source: 'preferred-desktop', evidence: 'inferred' },
    reports: [],
    failures: [],
    connectionCheck: false,
    running: false,
    ...overrides,
  }
}

/** Replace the global fetch for one test. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handler(String(url), init))
}

/** A JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Let queued microtasks and promise callbacks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createPanelStore initial state', () => {
  it('starts idle, with no snapshot and no failure', () => {
    const store = createPanelStore()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })
})

describe('load', () => {
  it('applies an empty status without inventing a snapshot', async () => {
    stubFetch(async () => json({ schemaVersion: 1, empty: true, running: false }))
    const store = createPanelStore()
    await store.load()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })

  it('applies a cached snapshot and marks it cached', async () => {
    stubFetch(async () => json({ ...snapshot(), schemaVersion: 1, empty: false }))
    const store = createPanelStore()
    await store.load()
    const state = store.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.cached).toBe(true)
    expect(state.snapshot?.host.dshVersion).toBe('0.2.2-rc.1')
    store.dispose()
  })

  it('keeps the previous snapshot when a read fails, so the panel does not blank out', async () => {
    let body: unknown = { ...snapshot(), schemaVersion: 1, empty: false }
    stubFetch(async () => json(body))
    const store = createPanelStore()
    await store.load()
    body = { error: 'internal-error' }
    vi.stubGlobal('fetch', async () => json({ error: 'internal-error' }, 500))
    await store.load()
    const state = store.getSnapshot()
    expect(state.phase).toBe('failed')
    expect(state.failure).toMatchObject({ kind: 'http', status: 500, code: 'internal-error' })
    expect(state.cached).toBe(true)
    expect(state.snapshot).toBeDefined()
    store.dispose()
  })
})

describe('diagnose', () => {
  it('reports a run as not cached, because it was just produced', async () => {
    stubFetch(async () => json({ ...snapshot(), empty: false }))
    const store = createPanelStore()
    await store.diagnose()
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', cached: false })
    store.dispose()
  })

  it('classifies an owner refusal as unauthorized rather than as an empty panel', async () => {
    stubFetch(async () => new Response('forbidden', { status: 403 }))
    const store = createPanelStore()
    await store.diagnose()
    const state = store.getSnapshot()
    expect(state.phase).toBe('failed')
    expect(state.failure).toEqual({ kind: 'unauthorized' })
    expect(state.snapshot).toBeUndefined()
    store.dispose()
  })

  it('classifies a transport failure as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    const store = createPanelStore()
    await store.diagnose()
    expect(store.getSnapshot().failure).toEqual({ kind: 'unreachable', detail: 'connect ECONNREFUSED' })
    store.dispose()
  })

  it('classifies a non-JSON answer as a bad payload', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>nope</html>', { status: 200 }))
    const store = createPanelStore()
    await store.diagnose()
    expect(store.getSnapshot().failure).toMatchObject({ kind: 'bad-payload' })
    store.dispose()
  })

  it('notifies subscribers on every transition', async () => {
    stubFetch(async () => json({ ...snapshot(), empty: false }))
    const store = createPanelStore()
    const seen: string[] = []
    const off = store.subscribe(() => seen.push(store.getSnapshot().phase))
    await store.diagnose()
    off()
    expect(seen).toEqual(['running', 'ready'])
    store.dispose()
  })

  it('stops notifying after unsubscribe', async () => {
    stubFetch(async () => json({ ...snapshot(), empty: false }))
    const store = createPanelStore()
    let calls = 0
    const off = store.subscribe(() => {
      calls += 1
    })
    off()
    await store.diagnose()
    expect(calls).toBe(0)
    store.dispose()
  })
})

describe('connect', () => {
  it('posts to the connection route and records that the run was a connection check', async () => {
    const urls: string[] = []
    stubFetch(async (url) => {
      urls.push(url)
      return json({ ...snapshot({ connectionCheck: true }), empty: false })
    })
    const store = createPanelStore()
    await store.connect()
    expect(urls[0]).toContain('/connect')
    expect(store.getSnapshot().snapshot?.connectionCheck).toBe(true)
    store.dispose()
  })
})

describe('cancellation', () => {
  it('settles back to idle when cancelled before any snapshot arrived', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const store = createPanelStore()
    const running = store.diagnose()
    expect(store.getSnapshot().phase).toBe('running')
    await store.cancel()
    // The aborted request must not flip the panel to `failed`.
    await running
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })

  it('returns to the previous snapshot when cancelled after one arrived', async () => {
    stubFetch(async () => json({ ...snapshot(), empty: false }))
    const store = createPanelStore()
    await store.diagnose()
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const running = store.connect()
    await store.cancel()
    await running
    expect(store.getSnapshot()).toMatchObject({ phase: 'ready', cached: false })
    store.dispose()
  })

  it('drops a late result from a superseded run', async () => {
    const resolvers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => resolvers.push(resolve)))
    const store = createPanelStore()
    const first = store.diagnose()
    const second = store.load()
    // Answer the newer request first, then let the older one finish late.
    resolvers[1]?.(json({ schemaVersion: 1, empty: true, running: false }))
    await second
    resolvers[0]?.(json({ ...snapshot({ observedAt: '1999-01-01T00:00:00.000Z' }), empty: false }))
    await first
    await settle()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })

  it('is safe to cancel when nothing is running', async () => {
    const store = createPanelStore()
    await expect(store.cancel()).resolves.toBeUndefined()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })

  it('does not throw when the transport ignores the abort signal', async () => {
    vi.stubGlobal('fetch', async () => json({ ...snapshot(), empty: false }))
    const store = createPanelStore()
    const running = store.diagnose()
    await store.cancel()
    await running
    // The result arrived after cancellation, so it must be dropped.
    expect(store.getSnapshot().phase).toBe('idle')
    store.dispose()
  })
})

describe('share', () => {
  it('returns the document when the Host has one', async () => {
    const report = {
      schemaVersion: 1,
      package: 'dsh-provider-doctor',
      version: '0.1.0',
      runtime: 'v24.21.0',
      platform: 'win32',
      architecture: 'x64',
      reports: [],
    }
    stubFetch(async () => json(report))
    const store = createPanelStore()
    await expect(store.share()).resolves.toMatchObject({ version: '0.1.0' })
    store.dispose()
  })

  it('returns undefined when no run has finished yet', async () => {
    stubFetch(async () => json({ error: 'no-report-yet' }, 409))
    const store = createPanelStore()
    await expect(store.share()).resolves.toBeUndefined()
    store.dispose()
  })

  it('does not disturb the panel state', async () => {
    stubFetch(async () => json({ error: 'no-report-yet' }, 409))
    const store = createPanelStore()
    await store.share()
    expect(store.getSnapshot()).toEqual({ phase: 'idle', cached: false })
    store.dispose()
  })
})

describe('dispose', () => {
  it('is safe to call twice', () => {
    const store = createPanelStore()
    store.dispose()
    expect(() => store.dispose()).not.toThrow()
  })

  it('aborts an in-flight request', async () => {
    let aborted = false
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    })
    const store = createPanelStore()
    const running = store.diagnose()
    store.dispose()
    await running
    expect(aborted).toBe(true)
  })
})
