import { describe, expect, it } from 'vitest'

import { createDiagnosticService } from '../../src/host/service.ts'
import type { HostFacts, ProfileFacts } from '../../src/host/runtime.ts'
import type { CheckResult } from '../../src/shared/contract.ts'
import type { AdapterContext, HostServices, ProviderAdapter } from '../../src/providers/types.ts'
import { pass } from '../../src/shared/check-helpers.ts'

const HOST_FACTS: HostFacts = {
  dshVersion: '0.2.2-rc.1',
  dshVersionSource: 'injected',
  nodeVersion: 'v24.0.0',
  platform: 'win32',
  arch: 'x64',
  dshHome: '/tmp/pd-service-home',
}

const PROFILE: ProfileFacts = {
  name: 'desktop',
  dir: '/tmp/pd-service-home/profiles/desktop',
  candidates: ['desktop'],
  source: 'single-profile',
  evidence: 'observed',
}

/** A context that serves exactly the services a test hands it. */
function contextWith(services: Record<string, unknown> = {}) {
  return { get: (name: string) => services[name] } as unknown as Parameters<typeof createDiagnosticService>[0]['context']
}

function adapterWith(
  id: string,
  produce: (context: AdapterContext) => Promise<CheckResult[]>,
  checks: readonly string[] = ['plugin-installed'],
): ProviderAdapter & { calls: () => number } {
  let calls = 0
  const adapter: ProviderAdapter = {
    id: id as ProviderAdapter['id'],
    displayName: id,
    pluginName: `plugin-${id}`,
    checks,
    diagnose: (context) => {
      calls += 1
      return produce(context)
    },
  }
  return Object.assign(adapter, { calls: () => calls })
}

function serviceWith(
  adapters: readonly ProviderAdapter[],
  services: Record<string, unknown> = {},
  locate = () => ({ hostFacts: HOST_FACTS, profile: PROFILE }),
) {
  return createDiagnosticService({ version: '0.1.0', adapters, context: contextWith(services), locate })
}

function ok(id: string): CheckResult {
  return pass({ id: id as CheckResult['id'], evidenceKind: 'observed', source: 'live_host', summary: `${id} ok` })
}

describe('createDiagnosticService', () => {
  it('reports nothing before the first run', () => {
    const service = serviceWith([])
    expect(service.last()).toBeUndefined()
    expect(service.shareable()).toBeUndefined()
  })

  it('keeps the snapshot it produced', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [ok('plugin-installed')])])
    const snapshot = await service.diagnose()
    expect(service.last()).toBe(snapshot)
    expect(snapshot.reports).toHaveLength(1)
  })

  it('records that a run finished rather than leaving it flagged as running', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [])])
    expect((await service.diagnose()).running).toBe(false)
  })

  it('records whether the connection check was requested', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [])])
    expect((await service.diagnose()).connectionCheck).toBe(false)
    const withConnection = await service.diagnose({ connectionCheck: true })
    // A second call joins the first run, so the flag is asserted on a fresh service.
    const fresh = serviceWith([adapterWith('workbuddy', async () => [])])
    expect((await fresh.diagnose({ connectionCheck: true })).connectionCheck).toBe(true)
    expect(withConnection.reports).toHaveLength(1)
  })

  it('joins an in-flight run instead of starting a second one', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = adapterWith('workbuddy', async () => {
      await gate
      return [ok('plugin-installed')]
    })
    const service = serviceWith([adapter])
    const first = service.diagnose()
    const second = service.diagnose()
    expect(adapter.calls()).toBe(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(adapter.calls()).toBe(1)
  })

  it('runs again after the previous run settled', async () => {
    const adapter = adapterWith('workbuddy', async () => [ok('plugin-installed')])
    const service = serviceWith([adapter])
    await service.diagnose()
    await service.diagnose()
    expect(adapter.calls()).toBe(2)
  })

  it('reads the inventory once per run even with several adapters', async () => {
    let reads = 0
    const inventory = {
      list: async () => {
        reads += 1
        return { entries: [] }
      },
    }
    const readsInventory = async (context: AdapterContext) => {
      await context.host.pluginInventory?.list()
      return [ok('plugin-installed')]
    }
    const service = serviceWith(
      [adapterWith('workbuddy', readsInventory), adapterWith('workbuddy-ai', readsInventory)],
      { pluginInventory: inventory },
    )
    await service.diagnose()
    expect(reads).toBe(1)
  })

  it('asks the inventory again on the next run, so a stale table is not reused', async () => {
    let reads = 0
    const inventory = {
      list: async () => {
        reads += 1
        return { entries: [] }
      },
    }
    const readsInventory = async (context: AdapterContext) => {
      await context.host.pluginInventory?.list()
      return []
    }
    const service = serviceWith([adapterWith('workbuddy', readsInventory)], { pluginInventory: inventory })
    await service.diagnose()
    await service.diagnose()
    expect(reads).toBe(2)
  })

  it('retries the inventory after a failure instead of caching the failure', async () => {
    let attempts = 0
    const inventory = {
      list: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return { entries: [] }
      },
    }
    const readsInventory = async (context: AdapterContext) => {
      try {
        await context.host.pluginInventory?.list()
      } catch {
        // The adapter treats an unreadable inventory as absent evidence.
      }
      return []
    }
    const service = serviceWith([adapterWith('workbuddy', readsInventory)], { pluginInventory: inventory })
    await service.diagnose()
    await service.diagnose()
    expect(attempts).toBe(2)
  })

  it('never hands an undefined service to an adapter', async () => {
    const seen: HostServices[] = []
    const service = serviceWith([adapterWith('workbuddy', async (context) => {
      seen.push(context.host)
      return []
    })], {})
    await service.diagnose()
    expect(Object.keys(seen[0] ?? {})).toEqual([])
  })

  it('passes llm and loader through when the host has them', async () => {
    const llm = { listProviders: () => [], listConfigurableProviders: () => [], listModels: async () => [] }
    const loader = { entries: () => [] }
    let seen: HostServices | undefined
    const service = serviceWith([adapterWith('workbuddy', async (context) => {
      seen = context.host
      return []
    })], { llm, loader })
    await service.diagnose()
    expect(seen?.llm).toBe(llm)
    expect(seen?.loader).toBe(loader)
  })

  it('cancels the run it is actually running', async () => {
    let sawAbort = false
    const service = serviceWith([adapterWith('workbuddy', async (context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => {
          sawAbort = true
          resolve()
        })
      })
      return [ok('plugin-installed')]
    })])
    const running = service.diagnose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await service.cancel()
    const snapshot = await running
    expect(sawAbort).toBe(true)
    // A stopped run reports itself as cancelled rather than as a stale result.
    expect(snapshot.reports[0]?.checks.some((check) => check.status === 'cancelled')).toBe(true)
  })

  it('cancel is a no-op when nothing is running', async () => {
    const service = serviceWith([])
    await expect(service.cancel()).resolves.toBeUndefined()
  })

  it('leaves the last snapshot readable after a cancel', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [ok('plugin-installed')])])
    const first = await service.diagnose()
    await service.cancel()
    expect(service.last()).toBe(first)
  })

  it('redacts a token out of a last-resort failure message', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => {
      throw new Error('Authorization: Bearer abcdefghijklmnop')
    })])
    const snapshot = await service.diagnose()
    expect(snapshot.failures[0]?.message).not.toContain('abcdefghijklmnop')
  })

  it('builds a shareable document from the last snapshot only', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [ok('plugin-installed')])])
    await service.diagnose()
    const shareable = service.shareable()
    expect(shareable?.schemaVersion).toBe(1)
    expect(shareable?.reports).toHaveLength(1)
    expect(JSON.stringify(shareable)).not.toContain('/tmp/pd-service-home')
  })

  it('refuses to run after disposal', async () => {
    const service = serviceWith([adapterWith('workbuddy', async () => [])])
    service.dispose()
    await expect(service.diagnose()).rejects.toThrow(/disposed/)
  })

  it('aborts an in-flight run on disposal', async () => {
    let sawAbort = false
    const service = serviceWith([adapterWith('workbuddy', async (context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => {
          sawAbort = true
          resolve()
        })
      })
      return []
    })])
    const running = service.diagnose()
    await new Promise((resolve) => setTimeout(resolve, 10))
    service.dispose()
    await running
    expect(sawAbort).toBe(true)
  })

  it('does not let a disposed service keep a snapshot it never finished', async () => {
    const service = serviceWith([adapterWith('workbuddy', async (context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve())
      })
      return []
    })])
    const running = service.diagnose()
    service.dispose()
    await running
    // Whatever landed is a settled snapshot, never a snapshot flagged as running.
    expect(service.last()?.running).toBe(false)
  })
})
