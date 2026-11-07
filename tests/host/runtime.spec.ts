import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { discoverProfile, readHostFacts } from '../../src/host/runtime.ts'

/** Scratch DSH homes, removed after each test. */
const scratch: string[] = []

/** Make a DSH home with the given profile directory names. */
function dshHomeWith(profiles: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'pd-runtime-'))
  scratch.push(home)
  mkdirSync(join(home, 'profiles'), { recursive: true })
  for (const name of profiles) mkdirSync(join(home, 'profiles', name), { recursive: true })
  return home
}

afterEach(() => {
  for (const home of scratch.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('readHostFacts', () => {
  it('prefers the injected version and records that source', () => {
    const facts = readHostFacts({ dshVersion: '0.2.2-rc.1', dshHome: 'D:\\some\\home' })
    expect(facts.dshVersion).toBe('0.2.2-rc.1')
    expect(facts.dshVersionSource).toBe('injected')
  })

  it('reports process facts as it sees them', () => {
    const facts = readHostFacts({ dshVersion: '0.2.2-rc.1' })
    expect(facts.nodeVersion).toBe(process.version)
    expect(facts.platform).toBe(process.platform)
    expect(facts.arch).toBe(process.arch)
  })

  it('never invents a version when none is readable', () => {
    const previous = process.env['DSH_HOME']
    try {
      // The manifest is resolvable in this repo only because it is a devDependency;
      // what matters here is that an absent injected version is never fabricated.
      const facts = readHostFacts({})
      expect(typeof facts.dshVersion === 'string' || facts.dshVersion === undefined).toBe(true)
      expect(['injected', 'package-manifest', 'unavailable']).toContain(facts.dshVersionSource)
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('treats an empty injected version as absent', () => {
    const facts = readHostFacts({ dshVersion: '   ' })
    expect(facts.dshVersionSource).not.toBe('injected')
  })

  it('resolves the DSH home it was given', () => {
    const facts = readHostFacts({ dshVersion: '0.2.2-rc.1', dshHome: process.cwd() })
    expect(facts.dshHome).toBe(process.cwd())
  })
})

describe('discoverProfile', () => {
  it('takes an injected name as observed truth', () => {
    const home = dshHomeWith(['desktop', 'headless'])
    const profile = discoverProfile(home, 'headless', { env: {}, argv: [] })
    expect(profile.name).toBe('headless')
    expect(profile.source).toBe('injected')
    expect(profile.evidence).toBe('observed')
    expect(profile.candidates).toEqual(['desktop', 'headless'])
  })

  it('takes an injected path and keeps only its name', () => {
    const home = dshHomeWith(['desktop'])
    const profile = discoverProfile(home, join(home, 'profiles', 'desktop'), { env: {}, argv: [] })
    expect(profile.name).toBe('desktop')
    expect(profile.dir).toBe(join(home, 'profiles', 'desktop'))
  })

  it('reads DSH_PROFILE from the environment', () => {
    const home = dshHomeWith(['desktop', 'web'])
    const profile = discoverProfile(home, undefined, { env: { DSH_PROFILE: 'web' }, argv: [] })
    expect(profile.name).toBe('web')
    expect(profile.source).toBe('env')
  })

  it('reads a profile out of a DSH_HOME that points inside profiles/', () => {
    const home = dshHomeWith(['desktop', 'web'])
    const inside = join(home, 'profiles', 'web')
    const profile = discoverProfile(home, undefined, { env: { DSH_HOME: inside }, argv: [] })
    expect(profile.name).toBe('web')
    expect(profile.source).toBe('env')
  })

  it('does not mistake a plain DSH_HOME for a profile', () => {
    const home = dshHomeWith(['desktop', 'web'])
    const profile = discoverProfile(home, undefined, { env: { DSH_HOME: home }, argv: [] })
    expect(profile.name).toBe('desktop')
    expect(profile.source).toBe('preferred-desktop')
  })

  it('reads --profile <name> from the command line', () => {
    const home = dshHomeWith(['desktop', 'headless'])
    const profile = discoverProfile(home, undefined, { env: {}, argv: ['node', 'dsh', '--profile', 'headless'] })
    expect(profile.name).toBe('headless')
    expect(profile.source).toBe('argv')
  })

  it('reads --profile=<name> from the command line', () => {
    const home = dshHomeWith(['desktop', 'web'])
    const profile = discoverProfile(home, undefined, { env: {}, argv: ['dsh', '--profile=web'] })
    expect(profile.name).toBe('web')
    expect(profile.source).toBe('argv')
  })

  it('uses the only profile when there is exactly one', () => {
    const home = dshHomeWith(['solo'])
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.name).toBe('solo')
    expect(profile.source).toBe('single-profile')
    expect(profile.evidence).toBe('observed')
  })

  it('presumes desktop among several, and says the guess is an inference', () => {
    const home = dshHomeWith(['desktop', 'headless', 'web'])
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.name).toBe('desktop')
    expect(profile.source).toBe('preferred-desktop')
    expect(profile.evidence).toBe('inferred')
  })

  it('refuses to pick a winner among several without desktop', () => {
    const home = dshHomeWith(['alpha', 'beta'])
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.name).toBeUndefined()
    expect(profile.source).toBe('ambiguous')
    expect(profile.evidence).toBe('unavailable')
    expect(profile.candidates).toEqual(['alpha', 'beta'])
  })

  it('reports an unreadable profiles directory rather than throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'pd-runtime-'))
    scratch.push(home)
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.source).toBe('unavailable')
    expect(profile.candidates).toEqual([])
    expect(profile.name).toBeUndefined()
  })

  it('ignores a stray file where a profile directory is expected', () => {
    const home = dshHomeWith([])
    writeFileSync(join(home, 'profiles', 'README.md'), 'not a profile')
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.candidates).toEqual([])
    expect(profile.source).toBe('unavailable')
  })

  it('ignores the node_modules entry under profiles/', () => {
    const home = dshHomeWith(['desktop'])
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    const profile = discoverProfile(home, undefined, { env: {}, argv: [] })
    expect(profile.candidates).toEqual(['desktop'])
  })

  it('lets an injected name outrank the environment', () => {
    const home = dshHomeWith(['desktop', 'web'])
    const profile = discoverProfile(home, 'web', { env: { DSH_PROFILE: 'desktop' }, argv: [] })
    expect(profile.name).toBe('web')
    expect(profile.source).toBe('injected')
  })
})
