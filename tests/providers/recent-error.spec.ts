import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hasProbeStore, recentErrorCheck } from '../../src/providers/recent-error.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pd-recent-'))
  scratch.push(dir)
  return dir
}

function store(contents: unknown, file = '.workbuddy-probe.json'): string {
  const dir = dshHome()
  writeFileSync(join(dir, file), typeof contents === 'string' ? contents : JSON.stringify(contents))
  return dir
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z')

describe('hasProbeStore', () => {
  it('knows the two WorkBuddy stores', () => {
    expect(hasProbeStore('workbuddy')).toBe(true)
    expect(hasProbeStore('workbuddy-ai')).toBe(true)
  })

  it('does not claim a store for ZCode', () => {
    expect(hasProbeStore('zcode-cli')).toBe(false)
  })

  it('is not fooled by inherited keys', () => {
    expect(hasProbeStore('toString')).toBe(false)
  })
})

describe('recentErrorCheck', () => {
  it('reports an absent store as unknown, never as a pass', () => {
    const check = recentErrorCheck({ dshHome: dshHome(), provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({
      id: 'recent-error',
      status: 'unknown',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: 'no_recorded_attempt',
      details: { probeStore: 'absent' },
    })
  })

  it('reports an unreadable file as unknown with its own reason code', () => {
    const check = recentErrorCheck({ dshHome: store('{ not json'), provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({ status: 'unknown', reasonCode: 'probe_store_unreadable' })
    expect(check.details).toMatchObject({ probeStore: 'unreadable' })
  })

  it('reports a non-object document as unreadable', () => {
    const check = recentErrorCheck({ dshHome: store('"a string"'), provider: 'workbuddy', now: NOW })
    expect(check.reasonCode).toBe('probe_store_unreadable')
  })

  it('reports an empty records map as no attempt', () => {
    const check = recentErrorCheck({ dshHome: store({ records: {} }), provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({ status: 'unknown', reasonCode: 'no_recorded_attempt' })
    expect(check.details).toMatchObject({ probeStore: 'empty' })
  })

  it('treats a document without a records key as empty', () => {
    const check = recentErrorCheck({ dshHome: store({ version: 1 }), provider: 'workbuddy', now: NOW })
    expect(check.details).toMatchObject({ probeStore: 'empty' })
  })

  it('passes when the newest attempt validated reasoning settings', () => {
    const dir = store({
      records: {
        'account-a': {
          'deepseek-v4.1-flash': { validation: 'validating', probedAtMs: NOW - 60_000, pluginVersion: '0.1.14' },
        },
      },
    })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({ status: 'pass', evidenceKind: 'observed', source: 'local_metadata' })
    expect(check.reasonCode).toBeUndefined()
    expect(check.details).toMatchObject({ probeStore: 'readable', entries: 1, lastValidation: 'validating' })
  })

  it('warns when the newest attempt rejected the reasoning settings', () => {
    const dir = store({
      records: {
        'account-a': {
          'deepseek-v4.1-flash': { validation: 'non-validating', probedAtMs: NOW - 5_000 },
        },
      },
    })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({
      status: 'warning',
      evidenceKind: 'observed',
      reasonCode: 'model_rejected_reasoning',
    })
    expect(check.nextSteps.length).toBeGreaterThan(0)
  })

  it('stays unknown when the newest attempt reached no conclusion', () => {
    const dir = store({
      records: { 'account-a': { 'model-x': { validation: 'unknown', probedAtMs: NOW - 10_000 } } },
    })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check).toMatchObject({ status: 'unknown', reasonCode: 'inconclusive_probe' })
  })

  it('uses the newest record, not the first one found', () => {
    const dir = store({
      records: {
        'account-z': { m: { validation: 'non-validating', probedAtMs: NOW - 500_000 } },
        'account-a': { m: { validation: 'validating', probedAtMs: NOW - 1_000 } },
      },
    })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check.status).toBe('pass')
    expect(check.details).toMatchObject({ entries: 2 })
  })

  it('ignores records without a numeric timestamp when picking the newest', () => {
    const dir = store({
      records: {
        a: { m: { validation: 'non-validating' } },
        b: { m: { validation: 'validating', probedAtMs: NOW - 1_000 } },
      },
    })
    expect(recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW }).status).toBe('pass')
  })

  it('still reads a verdict from a record that carries no timestamp', () => {
    const dir = store({ records: { a: { m: { validation: 'validating' } } } })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check.status).toBe('pass')
    expect(check.details).toMatchObject({ lastValidation: 'validating' })
    // Without a timestamp the age is omitted rather than invented.
    expect(check.details).not.toHaveProperty('lastAttempt')
    expect(check.summary).not.toContain('ago')
  })

  it('never reads account identifiers into the report', () => {
    const dir = store({
      records: {
        'account-should-not-appear': {
          'model-should-not-appear': { validation: 'validating', probedAtMs: NOW - 1_000 },
        },
      },
    })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    const serialized = JSON.stringify(check)
    expect(serialized).not.toContain('account-should-not-appear')
    expect(serialized).not.toContain('model-should-not-appear')
  })

  it('skips a record whose validation is not a string', () => {
    const dir = store({ records: { a: { m: { validation: 42, probedAtMs: NOW } } } })
    expect(recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW }).details).toMatchObject({
      probeStore: 'empty',
    })
  })

  it('skips a model value that is not an object', () => {
    const dir = store({ records: { a: { m: 'nope' } } })
    expect(recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW }).details).toMatchObject({
      probeStore: 'empty',
    })
  })

  it('reads the WorkBuddy AI store from its own file', () => {
    const dir = store(
      { records: { a: { m: { validation: 'validating', probedAtMs: NOW - 1_000 } } } },
      '.workbuddy-ai-probe.json',
    )
    expect(recentErrorCheck({ dshHome: dir, provider: 'workbuddy-ai', now: NOW }).status).toBe('pass')
  })

  it('does not read the other variant’s store', () => {
    const dir = store({ records: { a: { m: { validation: 'validating', probedAtMs: NOW } } } })
    expect(recentErrorCheck({ dshHome: dir, provider: 'workbuddy-ai', now: NOW }).reasonCode).toBe(
      'no_recorded_attempt',
    )
  })

  it('describes the age coarsely rather than printing a timestamp', () => {
    const dir = store({ records: { a: { m: { validation: 'validating', probedAtMs: NOW - 3 * 3_600_000 } } } })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check.details?.['lastAttempt']).toBe('about 3 hours ago')
    // The attempt time itself must not survive into the details: only the age.
    expect(JSON.stringify(check.details)).not.toContain('2026-11-07')
  })

  it('never reports a future timestamp as negative', () => {
    const dir = store({ records: { a: { m: { validation: 'validating', probedAtMs: NOW + 600_000 } } } })
    const check = recentErrorCheck({ dshHome: dir, provider: 'workbuddy', now: NOW })
    expect(check.details?.['lastAttempt']).toBe('less than two minutes ago')
  })
})
