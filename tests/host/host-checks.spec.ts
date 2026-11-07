import { describe, expect, it } from 'vitest'

import type { ProfileFacts, HostFacts } from '../../src/host/runtime.ts'
import { hostRuntimeCheck, pluginEnabledCheck, pluginInstalledCheck, profileIdentityCheck } from '../../src/host/host-checks.ts'
import type { PluginIdentity, PluginInventorySnapshot } from '../../src/providers/types.ts'

/** Facts for a host this plugin was verified on. */
function facts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    dshVersion: '0.2.2-rc.1',
    dshVersionSource: 'injected',
    nodeVersion: 'v22.19.0',
    platform: 'win32',
    arch: 'x64',
    dshHome: 'C:\\Users\\someone\\.dsh',
    ...overrides,
  }
}

/** A profile resolved from a single candidate. */
function profile(overrides: Partial<ProfileFacts> = {}): ProfileFacts {
  return {
    name: 'desktop',
    dir: 'C:\\Users\\someone\\.dsh\\profiles\\desktop',
    candidates: ['desktop'],
    source: 'single-profile',
    evidence: 'observed',
    ...overrides,
  }
}

/** One inventory row. */
function row(overrides: Partial<PluginInventorySnapshot['entries'][number]> = {}) {
  return {
    entryId: 'workbuddy',
    moduleName: 'dsh-workbuddy-connect-community',
    enabled: true,
    fiberPhase: 'active' as const,
    ...overrides,
  }
}

/** An inventory containing the given rows. */
function inventory(...rows: PluginInventorySnapshot['entries']): PluginInventorySnapshot {
  return { entries: rows }
}

const IDENTITY: PluginIdentity = { name: 'dsh-workbuddy-connect-community', version: '0.1.14', entryId: 'llm-workbuddy' }
const PACKAGE = 'dsh-workbuddy-connect-community'

describe('hostRuntimeCheck', () => {
  it('passes a build inside the verified range', () => {
    const result = hostRuntimeCheck({ facts: facts(), declaredRange: '0.2.2-rc.1' })
    expect(result.status).toBe('pass')
    expect(result.evidenceKind).toBe('observed')
    expect(result.details).toMatchObject({ dshVersion: '0.2.2-rc.1', declaredRange: '0.2.2-rc.1' })
  })

  it('warns, rather than failing, on a build outside the range', () => {
    const result = hostRuntimeCheck({ facts: facts({ dshVersion: '0.3.0' }), declaredRange: '0.2.2-rc.1' })
    expect(result.status).toBe('warning')
    expect(result.reasonCode).toBe('host_version_mismatch')
    expect(result.summary).toContain('0.3.0')
    expect(result.nextSteps.join(' ')).toContain('does not officially support')
  })

  it('is unknown, never out-of-range, when no version could be read', () => {
    const { dshVersion: _unread, ...unversioned } = facts()
    const result = hostRuntimeCheck({
      facts: { ...unversioned, dshVersionSource: 'unavailable' },
      declaredRange: '0.2.2-rc.1',
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('host_version_unreadable')
    expect(result.evidenceKind).toBe('unavailable')
  })

  it('is unknown when the reported version cannot be parsed', () => {
    const result = hostRuntimeCheck({ facts: facts({ dshVersion: 'nightly' }), declaredRange: '0.2.2-rc.1' })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('host_version_unreadable')
  })

  it('names its own damaged manifest when the range cannot be parsed', () => {
    const result = hostRuntimeCheck({ facts: facts(), declaredRange: 'not a range' })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('internal_error')
    expect(result.nextSteps.join(' ')).toContain('Reinstall')
  })
})

describe('profileIdentityCheck', () => {
  it('passes an observed profile', () => {
    const result = profileIdentityCheck({ profile: profile() })
    expect(result.status).toBe('pass')
    expect(result.evidenceKind).toBe('observed')
    expect(result.source).toBe('local_metadata')
    expect(result.summary).toContain('desktop')
  })

  it('passes an inferred profile but says so in both fields', () => {
    const result = profileIdentityCheck({
      profile: profile({ candidates: ['desktop', 'web'], source: 'preferred-desktop', evidence: 'inferred' }),
    })
    expect(result.status).toBe('pass')
    expect(result.evidenceKind).toBe('inferred')
    expect(result.details).toMatchObject({ inferred: true })
    expect(result.nextSteps.join(' ')).toContain('DSH_PROFILE')
  })

  it('credits an explicitly supplied profile to the person, not to a file', () => {
    const result = profileIdentityCheck({ profile: profile({ source: 'injected' }) })
    expect(result.source).toBe('user_supplied')
  })

  it('is unknown when no profile could be located at all', () => {
    const result = profileIdentityCheck({
      profile: { candidates: [], source: 'unavailable', evidence: 'unavailable' },
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('profile_unresolved')
    expect(result.summary).toContain('No DSH profile')
  })

  it('is unknown, and counts the candidates, when several exist and none wins', () => {
    const result = profileIdentityCheck({
      profile: { candidates: ['alpha', 'beta'], source: 'ambiguous', evidence: 'unavailable' },
    })
    expect(result.status).toBe('unknown')
    expect(result.summary).toContain('2 DSH profiles')
    expect(result.details).toMatchObject({ candidateCount: 2, resolution: 'ambiguous' })
  })
})

describe('pluginInstalledCheck', () => {
  it('passes from a live inventory row', () => {
    const result = pluginInstalledCheck({
      pluginName: PACKAGE,
      identity: IDENTITY,
      inventory: inventory(row()),
      dependencies: undefined,
    })
    expect(result.status).toBe('pass')
    expect(result.evidenceKind).toBe('observed')
    expect(result.source).toBe('live_host')
    expect(result.details).toMatchObject({ package: PACKAGE, version: '0.1.14' })
  })

  it('passes from the profile manifest, credited to local metadata', () => {
    const result = pluginInstalledCheck({
      pluginName: PACKAGE,
      identity: IDENTITY,
      inventory: undefined,
      dependencies: { [PACKAGE]: '^0.1.14' },
    })
    expect(result.status).toBe('pass')
    expect(result.source).toBe('local_metadata')
    expect(result.summary).toContain('dependency records')
  })

  it('fails when the inventory is authoritative and lacks the package', () => {
    const result = pluginInstalledCheck({
      pluginName: PACKAGE,
      identity: IDENTITY,
      inventory: inventory(row({ moduleName: 'something-else', entryId: 'other' })),
      dependencies: undefined,
    })
    expect(result.status).toBe('fail')
    expect(result.reasonCode).toBe('plugin_missing')
  })

  it('refuses to claim missing when nothing could be read', () => {
    const result = pluginInstalledCheck({
      pluginName: PACKAGE,
      identity: IDENTITY,
      inventory: undefined,
      dependencies: undefined,
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('inventory_unavailable')
    expect(result.source).toBe('fallback')
  })

  it('finds a row by the adapter entry id when the module name differs', () => {
    const result = pluginInstalledCheck({
      pluginName: '',
      identity: IDENTITY,
      inventory: inventory(row({ moduleName: 'llm-workbuddy', entryId: 'llm-workbuddy' })),
      dependencies: undefined,
    })
    expect(result.status).toBe('pass')
    expect(result.details).toMatchObject({ entryId: 'llm-workbuddy' })
  })
})

describe('pluginEnabledCheck', () => {
  const base = { pluginName: PACKAGE, identity: IDENTITY }

  it('passes an enabled, active entry', () => {
    const result = pluginEnabledCheck({ ...base, inventory: inventory(row()) })
    expect(result.status).toBe('pass')
    expect(result.details).toMatchObject({ enabled: true, fiberPhase: 'active' })
  })

  it('fails an installed but disabled plugin', () => {
    const result = pluginEnabledCheck({ ...base, inventory: inventory(row({ enabled: false })) })
    expect(result.status).toBe('fail')
    expect(result.reasonCode).toBe('plugin_disabled')
  })

  it('fails a fiber that failed to start, carrying the loader diagnostic', () => {
    const result = pluginEnabledCheck({
      ...base,
      inventory: inventory(row({ fiberPhase: 'failed', diagnostic: 'cannot find module pi-ai' })),
    })
    expect(result.status).toBe('fail')
    expect(result.reasonCode).toBe('plugin_failed')
    expect(result.details).toMatchObject({ diagnostic: 'cannot find module pi-ai' })
  })

  it('warns, not fails, when the snapshot caught a transient phase', () => {
    for (const phase of ['pending', 'loading', 'unloading'] as const) {
      const result = pluginEnabledCheck({ ...base, inventory: inventory(row({ fiberPhase: phase })) })
      expect(result.status).toBe('warning')
      expect(result.reasonCode).toBe('plugin_not_loaded')
    }
  })

  it('is unknown when the inventory omits the fiber phase', () => {
    const result = pluginEnabledCheck({ ...base, inventory: inventory(row({ fiberPhase: null })) })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('plugin_not_loaded')
  })

  it('declines rather than guessing when there is no row', () => {
    const result = pluginEnabledCheck({ ...base, inventory: inventory(row({ moduleName: 'other', entryId: 'other' })) })
    expect(result.status).toBe('not_checked')
    expect(result.reasonCode).toBe('not_requested')
    expect(result.source).toBe('live_host')
  })

  it('declines and says the host has no inventory at all', () => {
    const result = pluginEnabledCheck({ ...base, inventory: undefined })
    expect(result.status).toBe('not_checked')
    expect(result.source).toBe('fallback')
    expect(result.summary).toContain('No plugin inventory')
  })

  it('finds the row by entry id when the module name does not match', () => {
    const result = pluginEnabledCheck({
      ...base,
      pluginName: '',
      inventory: inventory(row({ entryId: 'llm-workbuddy', moduleName: 'llm-workbuddy' })),
    })
    expect(result.status).toBe('pass')
  })
})
