import { describe, expect, it } from 'vitest'

import { checkEngineRange } from '../../src/host/runtime.ts'

/**
 * The range checker is a hand-written subset of npm's grammar, so the tests pin
 * the cases the plugin actually relies on: its own `engines.dsh` string and the
 * shapes a future host version takes.
 */
describe('checkEngineRange', () => {
  const range = '0.2.2-rc.1'

  it('accepts the exact verified build', () => {
    expect(checkEngineRange('0.2.2-rc.1', range)).toEqual({ ok: true })
  })

  it('rejects a different prerelease of the same tuple', () => {
    expect(checkEngineRange('0.2.2-rc.2', range)).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('rejects the final release of a tuple pinned to its prerelease', () => {
    expect(checkEngineRange('0.2.2', range)).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('reports an unreadable version rather than guessing one', () => {
    expect(checkEngineRange('', range)).toEqual({ ok: false, reason: 'invalid_version' })
    expect(checkEngineRange('not-a-version', range)).toEqual({ ok: false, reason: 'invalid_version' })
  })

  it('reports a range it cannot parse instead of treating it as satisfied', () => {
    expect(checkEngineRange('0.2.2-rc.1', 'not a range')).toEqual({ ok: false, reason: 'invalid_range' })
  })

  it('handles the `||` alternatives the WorkBuddy plugin declares', () => {
    const alternatives = '0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1'
    expect(checkEngineRange('0.2.1-rc.3', alternatives)).toEqual({ ok: true })
    expect(checkEngineRange('0.2.2-rc.1', alternatives)).toEqual({ ok: true })
    expect(checkEngineRange('0.2.2-rc.2', alternatives)).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('desugars caret ranges above 0', () => {
    expect(checkEngineRange('0.2.9', '^0.2.1')).toEqual({ ok: true })
    expect(checkEngineRange('0.2.0', '^0.2.1')).toEqual({ ok: false, reason: 'out_of_range' })
    expect(checkEngineRange('0.2.2-rc.1', '^0.2.1')).toEqual({ ok: true })
  })

  it('keeps the next tuple out of a caret range', () => {
    expect(checkEngineRange('0.3.0', '^0.2.1')).toEqual({ ok: false, reason: 'out_of_range' })
    expect(checkEngineRange('0.3.0-rc.1', '^0.2.1')).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('treats caret below 1.0 per npm rules', () => {
    expect(checkEngineRange('0.0.4', '^0.0.3')).toEqual({ ok: false, reason: 'out_of_range' })
    expect(checkEngineRange('0.0.3', '^0.0.3')).toEqual({ ok: true })
  })

  it('desugars tilde ranges', () => {
    expect(checkEngineRange('0.2.9', '~0.2.3')).toEqual({ ok: true })
    expect(checkEngineRange('0.3.0', '~0.2.3')).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('supports space-separated ANDed comparators', () => {
    expect(checkEngineRange('0.2.5', '>=0.2.0 <0.3.0')).toEqual({ ok: true })
    expect(checkEngineRange('0.3.0', '>=0.2.0 <0.3.0')).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('orders prereleases by semver precedence', () => {
    expect(checkEngineRange('0.2.2-rc.10', '>0.2.2-rc.9')).toEqual({ ok: true })
    expect(checkEngineRange('0.2.2-rc.2', '<0.2.2-rc.10')).toEqual({ ok: true })
  })

  it('ranks a release above every prerelease of the same tuple', () => {
    expect(checkEngineRange('0.2.2', '>0.2.2-rc.9')).toEqual({ ok: true })
  })

  it('accepts a leading v and ignores build metadata', () => {
    expect(checkEngineRange('v0.2.2-rc.1', range)).toEqual({ ok: true })
    expect(checkEngineRange('0.2.2-rc.1+abc123', range)).toEqual({ ok: true })
  })

  it('treats `*` as no claim rather than as a fabricated requirement', () => {
    expect(checkEngineRange('0.0.1', '*')).toEqual({ ok: true })
    expect(checkEngineRange('99.0.0-rc.1', '*')).toEqual({ ok: true })
  })
})
