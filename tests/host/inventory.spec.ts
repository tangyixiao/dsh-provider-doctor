import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  findEntryByPackage,
  readInventory,
  readProfileDependencies,
  resolvePluginState,
  resolvePluginStateFromEvidence,
} from '../../src/host/inventory.ts'
import type { HostServices, PluginInventorySnapshot } from '../../src/providers/types.ts'

const PACKAGE = 'dsh-workbuddy-connect-community'

const scratch: string[] = []

/** A scratch profile directory. */
function profileDirWith(manifest: unknown | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'pd-inventory-'))
  scratch.push(dir)
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One inventory row. */
function row(overrides: Partial<PluginInventorySnapshot['entries'][number]> = {}) {
  return {
    entryId: 'llm-workbuddy',
    moduleName: PACKAGE,
    enabled: true,
    fiberPhase: 'active' as const,
    ...overrides,
  }
}

describe('readInventory', () => {
  it('returns undefined when the host has no inventory service', async () => {
    expect(await readInventory({})).toBeUndefined()
  })

  it('returns undefined when the service rejects', async () => {
    const host: HostServices = {
      pluginInventory: {
        list: async () => {
          throw new Error('gateway down')
        },
      },
    }
    expect(await readInventory(host)).toBeUndefined()
  })

  it('normalises a well-formed snapshot', async () => {
    const host: HostServices = {
      pluginInventory: { list: async () => ({ managementAvailable: true, entries: [row()] }) },
    }
    const snapshot = await readInventory(host)
    expect(snapshot?.entries).toHaveLength(1)
    expect(snapshot?.managementAvailable).toBe(true)
  })

  it('drops a row that does not state its enabled flag rather than defaulting it', async () => {
    const host = {
      pluginInventory: {
        list: async () => ({ entries: [{ entryId: 'a', moduleName: 'b' }, row()] }),
      },
    } as unknown as HostServices
    const snapshot = await readInventory(host)
    expect(snapshot?.entries).toHaveLength(1)
    expect(snapshot?.entries[0]?.entryId).toBe('llm-workbuddy')
  })

  it('normalises an unknown fiber phase to null instead of guessing one', async () => {
    const host = {
      pluginInventory: { list: async () => ({ entries: [{ ...row(), fiberPhase: 'levitating' }] }) },
    } as unknown as HostServices
    const snapshot = await readInventory(host)
    expect(snapshot?.entries[0]?.fiberPhase).toBeNull()
  })

  it('rejects a document without an entries array', async () => {
    const host = { pluginInventory: { list: async () => ({ rows: [] }) } } as unknown as HostServices
    expect(await readInventory(host)).toBeUndefined()
  })
})

describe('findEntryByPackage', () => {
  const snapshot: PluginInventorySnapshot = {
    entries: [row({ entryId: PACKAGE, moduleName: 'some-other-package' }), row()],
  }

  it('prefers a moduleName match over an entryId match', () => {
    expect(findEntryByPackage(snapshot, PACKAGE)?.moduleName).toBe(PACKAGE)
  })

  it('falls back to an entryId match when no moduleName matches', () => {
    expect(findEntryByPackage({ entries: [row({ entryId: PACKAGE, moduleName: 'x' })] }, PACKAGE)?.entryId).toBe(PACKAGE)
  })

  it('returns undefined when no snapshot was read', () => {
    expect(findEntryByPackage(undefined, PACKAGE)).toBeUndefined()
  })
})

describe('readProfileDependencies', () => {
  it('merges dependencies and devDependencies', () => {
    const dir = profileDirWith({
      dependencies: { a: '1.0.0' },
      devDependencies: { b: '2.0.0' },
    })
    expect(readProfileDependencies(dir)).toEqual({ a: '1.0.0', b: '2.0.0' })
  })

  it('keeps the dependencies range when both sections declare a package', () => {
    const dir = profileDirWith({
      dependencies: { a: '1.0.0' },
      devDependencies: { a: '9.9.9' },
    })
    expect(readProfileDependencies(dir)?.['a']).toBe('1.0.0')
  })

  it('ignores a non-string range', () => {
    const dir = profileDirWith({ dependencies: { a: 42, b: '2.0.0' } })
    expect(readProfileDependencies(dir)).toEqual({ b: '2.0.0' })
  })

  it('returns undefined when the manifest is missing', () => {
    expect(readProfileDependencies(profileDirWith(undefined))).toBeUndefined()
  })

  it('returns undefined when the manifest is not JSON', () => {
    expect(readProfileDependencies(profileDirWith('{ not json'))).toBeUndefined()
  })

  it('returns undefined when neither dependency section exists', () => {
    expect(readProfileDependencies(profileDirWith({ name: 'desktop' }))).toBeUndefined()
  })

  it('returns an empty map when a section exists but declares nothing', () => {
    expect(readProfileDependencies(profileDirWith({ dependencies: {} }))).toEqual({})
  })

  it('returns undefined when no profile directory was resolved', () => {
    expect(readProfileDependencies(undefined)).toBeUndefined()
  })
})

describe('resolvePluginStateFromEvidence', () => {
  it('prefers the live inventory row', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: { entries: [row()] },
      dependencies: undefined,
    })
    expect(state).toMatchObject({ present: true, source: 'inventory' })
  })

  it('falls back to the manifest when the inventory has no row and still declares it', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: { entries: [] },
      dependencies: { [PACKAGE]: '^0.1.14' },
    })
    expect(state).toMatchObject({ present: true, source: 'manifest' })
  })

  it('reports absent when a complete inventory lacks the row', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: { entries: [] },
      dependencies: undefined,
    })
    expect(state).toMatchObject({ present: false, source: 'inventory' })
  })

  it('does not report absent from a partial inventory', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: { managementAvailable: false, entries: [] },
      dependencies: undefined,
    })
    expect(state.present).toBeUndefined()
    expect(state.source).toBe('unavailable')
  })

  it('reports absent from the manifest when no section declares it', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: undefined,
      dependencies: {},
    })
    expect(state).toMatchObject({ present: false, source: 'manifest' })
  })

  it('is undecidable with no evidence at all', () => {
    const state = resolvePluginStateFromEvidence({
      packageName: PACKAGE,
      inventory: undefined,
      dependencies: undefined,
    })
    expect(state).toEqual({ present: undefined, source: 'unavailable' })
  })

  it('does not treat an inherited property as a declaration', () => {
    const dependencies = Object.create({ [PACKAGE]: '1.0.0' }) as Record<string, string>
    const state = resolvePluginStateFromEvidence({ packageName: PACKAGE, inventory: undefined, dependencies })
    expect(state.present).toBe(false)
  })
})

describe('resolvePluginState', () => {
  it('asks the loader only when the inventory service is absent', async () => {
    let loaderReads = 0
    const withInventory: HostServices = {
      pluginInventory: { list: async () => ({ entries: [] }) },
      loader: {
        entries: () => {
          loaderReads += 1
          return []
        },
      },
    }
    await resolvePluginState(withInventory, undefined, PACKAGE)
    expect(loaderReads).toBe(0)
  })

  it('labels a loader hit as loader, so callers can mark it inferred', async () => {
    const host: HostServices = {
      loader: {
        entries: () => [{ options: { id: 'llm-workbuddy', name: PACKAGE }, disabled: false }],
      },
    }
    const state = await resolvePluginState(host, undefined, PACKAGE)
    expect(state).toMatchObject({ present: true, source: 'loader' })
    expect(state.entry?.fiberPhase).toBeNull()
  })

  it('does not claim a loader hit as active, because Cordis state is unreadable here', async () => {
    const host: HostServices = {
      loader: { entries: () => [{ options: { id: 'a', name: PACKAGE } }] },
    }
    const state = await resolvePluginState(host, undefined, PACKAGE)
    expect(state.entry?.enabled).toBe(true)
    expect(state.entry?.fiberPhase).toBeNull()
  })

  it('ignores a group row in the loader table', async () => {
    const host: HostServices = {
      loader: { entries: () => [{ options: { id: PACKAGE, name: PACKAGE, group: true } }] },
    }
    const state = await resolvePluginState(host, undefined, PACKAGE)
    expect(state.source).toBe('unavailable')
  })

  it('survives a loader table that throws mid-iteration', async () => {
    const host: HostServices = {
      loader: {
        entries: () =>
          ({
            [Symbol.iterator]: () => ({
              next: () => {
                throw new Error('table corrupted')
              },
            }),
          }) as unknown as Iterable<never>,
      },
    }
    const state = await resolvePluginState(host, undefined, PACKAGE)
    expect(state.source).toBe('unavailable')
  })

  it('never throws, whatever the sources do', async () => {
    const host: HostServices = {
      pluginInventory: {
        list: async () => {
          throw new Error('boom')
        },
      },
      loader: {
        entries: () => {
          throw new Error('boom again')
        },
      },
    }
    await expect(resolvePluginState(host, join(tmpdir(), 'does-not-exist'), PACKAGE)).resolves.toMatchObject({
      source: 'unavailable',
    })
  })

  it('reads the profile manifest for the running profile', async () => {
    const dir = profileDirWith({ dependencies: { [PACKAGE]: '^0.1.14' } })
    mkdirSync(join(dir, 'unused'), { recursive: true })
    const state = await resolvePluginState({}, dir, PACKAGE)
    expect(state).toMatchObject({ present: true, source: 'manifest' })
  })
})
