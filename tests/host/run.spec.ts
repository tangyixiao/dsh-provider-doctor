import { describe, expect, it } from 'vitest'

import { runDiagnostics, type RunInput } from '../../src/host/run.ts'
import type { HostFacts, ProfileFacts } from '../../src/host/runtime.ts'
import type { CheckResult } from '../../src/shared/contract.ts'
import type { AdapterContext, ProviderAdapter } from '../../src/providers/types.ts'
import { pass } from '../../src/shared/check-helpers.ts'

const HOST: HostFacts = {
  dshVersion: '0.2.2-rc.1',
  dshVersionSource: 'injected',
  nodeVersion: 'v24.0.0',
  platform: 'win32',
  arch: 'x64',
  dshHome: 'C:/Users/x/.dsh',
}

const PROFILE: ProfileFacts = {
  name: 'desktop',
  dir: 'C:/Users/x/.dsh/profiles/desktop',
  candidates: ['desktop'],
  source: 'single-profile',
  evidence: 'observed',
}

function controller(): AbortController {
  return new AbortController()
}

/** An adapter that returns the given checks. */
function adapterWith(
  id: string,
  checks: readonly string[],
  produce: (context: AdapterContext) => Promise<CheckResult[]>,
): ProviderAdapter {
  return {
    id: id as ProviderAdapter['id'],
    displayName: id,
    pluginName: `plugin-${id}`,
    checks,
    diagnose: produce,
  }
}

function baseInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    adapters: [],
    host: {},
    hostFacts: HOST,
    profile: PROFILE,
    dshHome: 'C:/Users/x/.dsh',
    signal: controller().signal,
    ...overrides,
  }
}

function healthy(id: string): CheckResult {
  return pass({ id: id as CheckResult['id'], evidenceKind: 'observed', source: 'live_host', summary: `${id} ok` })
}

describe('runDiagnostics', () => {
  it('returns one report per adapter', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [
        adapterWith('workbuddy', ['plugin-installed'], async () => [healthy('plugin-installed')]),
        adapterWith('workbuddy-ai', ['plugin-installed'], async () => [healthy('plugin-installed')]),
      ],
    }))
    expect(run.reports.map((report) => report.provider)).toEqual(['workbuddy', 'workbuddy-ai'])
    expect(run.failures).toEqual([])
  })

  it('always prepends the two host-level checks', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', ['plugin-installed'], async () => [healthy('plugin-installed')])],
    }))
    const ids = run.reports[0]?.checks.map((check) => check.id)
    expect(ids).toEqual(['host-runtime', 'profile-identity', 'plugin-installed'])
  })

  it('gives every report the same host evidence', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [
        adapterWith('workbuddy', [], async () => []),
        adapterWith('zcode-cli', [], async () => []),
      ],
    }))
    const first = run.reports[0]?.checks.filter((check) => check.id === 'host-runtime')
    const second = run.reports[1]?.checks.filter((check) => check.id === 'host-runtime')
    expect(first?.[0]?.status).toBe(second?.[0]?.status)
  })

  it('reports a host version outside the declared range as a warning', async () => {
    const run = await runDiagnostics(baseInput({
      options: { engineRange: '1.0.0' },
      adapters: [adapterWith('workbuddy', [], async () => [])],
    }))
    const hostRuntime = run.reports[0]?.checks.find((check) => check.id === 'host-runtime')
    expect(hostRuntime).toMatchObject({ status: 'warning', reasonCode: 'host_version_mismatch' })
  })

  it('orders checks by chain order rather than by return order', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith(
        'workbuddy',
        ['model-catalog', 'plugin-installed'],
        async () => [healthy('model-catalog'), healthy('plugin-installed')],
      )],
    }))
    expect(run.reports[0]?.checks.map((check) => check.id)).toEqual([
      'host-runtime',
      'profile-identity',
      'plugin-installed',
      'model-catalog',
    ])
  })

  it('drops duplicate check ids, keeping the first', async () => {
    const first = pass({ id: 'plugin-installed', evidenceKind: 'observed', source: 'live_host', summary: 'first' })
    const second = pass({ id: 'plugin-installed', evidenceKind: 'observed', source: 'live_host', summary: 'second' })
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', ['plugin-installed'], async () => [first, second])],
    }))
    const installed = run.reports[0]?.checks.filter((check) => check.id === 'plugin-installed')
    expect(installed).toHaveLength(1)
    expect(installed?.[0]?.summary).toBe('first')
  })

  it('reports every promised check as a timeout when an adapter overruns', async () => {
    const run = await runDiagnostics(baseInput({
      options: { adapterBudgetMs: 20 },
      adapters: [adapterWith('workbuddy', ['plugin-installed', 'model-catalog'], () => new Promise(() => {}))],
    }))
    const statuses = run.reports[0]?.checks.map((check) => [check.id, check.status])
    expect(statuses).toEqual([
      ['host-runtime', 'pass'],
      ['profile-identity', 'pass'],
      ['plugin-installed', 'timeout'],
      ['model-catalog', 'timeout'],
    ])
    expect(run.failures).toEqual([])
  })

  it('does not report a timeout as a failure of the provider', async () => {
    const run = await runDiagnostics(baseInput({
      options: { adapterBudgetMs: 20 },
      adapters: [adapterWith('workbuddy', ['credential-metadata'], () => new Promise(() => {}))],
    }))
    const credential = run.reports[0]?.checks.find((check) => check.id === 'credential-metadata')
    expect(credential).toMatchObject({ status: 'timeout', reasonCode: 'timed_out' })
    expect(JSON.stringify(credential)).not.toMatch(/signed out|not signed in/i)
  })

  it('degrades a throwing adapter to one unknown check and keeps the others reporting', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [
        adapterWith('workbuddy', ['plugin-installed'], async () => {
          throw new Error('adapter exploded')
        }),
        adapterWith('zcode-cli', ['plugin-installed'], async () => [healthy('plugin-installed')]),
      ],
    }))
    expect(run.reports).toHaveLength(2)
    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]?.provider).toBe('workbuddy')
    const diagnostic = run.reports[0]?.checks.find((check) => check.id === 'provider-diagnostic')
    expect(diagnostic).toMatchObject({ status: 'unknown', reasonCode: 'internal_error' })
    expect(run.reports[1]?.checks.some((check) => check.status === 'pass')).toBe(true)
  })

  it('redacts a secret out of a failure message', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', [], async () => {
        throw new Error('token=supersecretvalue failed')
      })],
    }))
    expect(run.failures[0]?.message).not.toContain('supersecretvalue')
  })

  it('reports a cancelled adapter as cancelled, not as a failure', async () => {
    const outer = controller()
    const run = await runDiagnostics(baseInput({
      signal: outer.signal,
      adapters: [adapterWith('workbuddy', ['plugin-installed'], async (context) => {
        outer.abort()
        expect(context.signal.aborted).toBe(true)
        return new Promise(() => {})
      })],
    }))
    const diagnostic = run.reports[0]?.checks.find((check) => check.id === 'provider-diagnostic')
    expect(diagnostic).toMatchObject({ status: 'cancelled', reasonCode: 'cancelled' })
    expect(run.failures).toEqual([])
  })

  it('passes the connection flag through to each adapter', async () => {
    const seen: boolean[] = []
    await runDiagnostics(baseInput({
      options: { connectionCheck: true },
      adapters: [adapterWith('workbuddy', [], async (context) => {
        seen.push(context.connectionCheck)
        return []
      })],
    }))
    expect(seen).toEqual([true])
  })

  it('defaults the connection flag to false', async () => {
    const seen: boolean[] = []
    await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', [], async (context) => {
        seen.push(context.connectionCheck)
        return []
      })],
    }))
    expect(seen).toEqual([false])
  })

  it('passes the profile directory when one was resolved', async () => {
    const seen: (string | undefined)[] = []
    await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', [], async (context) => {
        seen.push(context.profileDir)
        return []
      })],
    }))
    expect(seen).toEqual([PROFILE.dir])
  })

  it('omits the profile directory when none was resolved', async () => {
    const seen: (string | undefined)[] = []
    await runDiagnostics(baseInput({
      profile: { candidates: [], source: 'unavailable', evidence: 'unavailable' },
      adapters: [adapterWith('workbuddy', [], async (context) => {
        seen.push(context.profileDir)
        return []
      })],
    }))
    expect(seen).toEqual([undefined])
  })

  it('names the profile as unknown rather than inventing one', async () => {
    const run = await runDiagnostics(baseInput({
      profile: { candidates: [], source: 'unavailable', evidence: 'unavailable' },
      adapters: [adapterWith('workbuddy', [], async () => [])],
    }))
    expect(run.reports[0]?.profile).toEqual({ kind: 'live_host', identity: 'unknown' })
  })

  it('records the host facts on every report', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', [], async () => [])],
    }))
    expect(run.reports[0]?.host).toEqual({
      dshVersion: '0.2.2-rc.1',
      nodeVersion: 'v24.0.0',
      platform: 'win32',
      arch: 'x64',
    })
  })

  it('omits an unknown DSH version instead of writing a placeholder', async () => {
    const { dshVersion: _ignored, ...withoutVersion } = HOST
    const run = await runDiagnostics(baseInput({
      hostFacts: { ...withoutVersion, dshVersionSource: 'unavailable' },
      adapters: [adapterWith('workbuddy', [], async () => [])],
    }))
    expect(run.reports[0]?.host).not.toHaveProperty('dshVersion')
  })

  it('keeps a check whose id is outside the shared chain order', async () => {
    const run = await runDiagnostics(baseInput({
      adapters: [adapterWith('workbuddy', [], async () => [
        pass({ id: 'custom-check' as CheckResult['id'], evidenceKind: 'observed', source: 'live_host', summary: 'x' }),
      ])],
    }))
    expect(run.reports[0]?.checks.at(-1)?.id).toBe('custom-check')
  })

  it('runs adapters concurrently rather than one after another', async () => {
    const order: string[] = []
    await runDiagnostics(baseInput({
      adapters: [
        adapterWith('workbuddy', [], async () => {
          order.push('workbuddy-start')
          await new Promise((resolve) => setTimeout(resolve, 30))
          order.push('workbuddy-end')
          return []
        }),
        adapterWith('zcode-cli', [], async () => {
          order.push('zcode-start')
          await new Promise((resolve) => setTimeout(resolve, 5))
          order.push('zcode-end')
          return []
        }),
      ],
    }))
    expect(order.indexOf('zcode-start')).toBeLessThan(order.indexOf('workbuddy-end'))
  })

  it('returns no reports for no adapters', async () => {
    const run = await runDiagnostics(baseInput({ adapters: [] }))
    expect(run.reports).toEqual([])
    expect(run.failures).toEqual([])
  })
})
