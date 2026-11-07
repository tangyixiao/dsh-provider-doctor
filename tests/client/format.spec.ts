import { describe, expect, it } from 'vitest'

import { prettyDetails, relativeTime, type Translate } from '../../src/client/format.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ProviderDoctorKey } from '../../src/client/locales.ts'

/** A translator that renders `key` and its params, so assertions can see both. */
const t: Translate = (key, params) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

describe('relativeTime', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z')

  it('describes an instant seconds old as just now', () => {
    expect(relativeTime('2026-11-07T11:59:30.000Z', t, now)).toBe(en['time.justNow'])
  })

  it('counts minutes under an hour', () => {
    expect(relativeTime('2026-11-07T11:48:00.000Z', t, now)).toBe('12 min ago')
  })

  it('counts hours under a day', () => {
    expect(relativeTime('2026-11-07T09:00:00.000Z', t, now)).toBe('3 h ago')
  })

  it('counts days beyond that', () => {
    expect(relativeTime('2026-11-04T12:00:00.000Z', t, now)).toBe('3 d ago')
  })

  it('rounds rather than truncates, so 59 minutes does not read as an hour', () => {
    expect(relativeTime('2026-11-07T11:00:31.000Z', t, now)).toBe('59 min ago')
  })

  it('returns a value it cannot parse verbatim instead of inventing a time', () => {
    expect(relativeTime('not-a-date', t, now)).toBe('not-a-date')
  })

  it('does not print an absolute timestamp', () => {
    expect(relativeTime('2026-11-07T11:48:00.000Z', t, now)).not.toContain('2026')
  })
})

describe('prettyDetails', () => {
  it('renders an empty string for absent details', () => {
    expect(prettyDetails(undefined)).toBe('')
  })

  it('renders an empty string for an empty record', () => {
    expect(prettyDetails({})).toBe('')
  })

  it('pretty-prints with two-space indentation', () => {
    expect(prettyDetails({ provider: 'workbuddy', count: 2 })).toBe(
      '{\n  "provider": "workbuddy",\n  "count": 2\n}',
    )
  })

  it('keeps insertion order', () => {
    const text = prettyDetails({ z: 1, a: 2 })
    expect(text.indexOf('"z"')).toBeLessThan(text.indexOf('"a"'))
  })
})

describe('dictionaries', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()

  it('define the same keys in both languages', () => {
    expect(enKeys).toEqual(zhKeys)
  })

  it('define no empty strings', () => {
    for (const key of zhKeys) {
      expect(zh[key as ProviderDoctorKey].trim(), `zh.${key}`).not.toBe('')
      expect(en[key as ProviderDoctorKey].trim(), `en.${key}`).not.toBe('')
    }
  })

  it('define every key the panel asks for at runtime', () => {
    // These are built dynamically, so a missing entry would only show up as a
    // dangling key in the UI.
    const required: ProviderDoctorKey[] = [
      'status.pass',
      'status.fail',
      'status.warning',
      'status.unknown',
      'status.not_checked',
      'status.timeout',
      'status.cancelled',
      'evidence.observed',
      'evidence.inferred',
      'evidence.unavailable',
      'source.live_host',
      'source.provider_diagnostic',
      'source.local_metadata',
      'source.user_supplied',
      'source.fallback',
      'check.host-runtime',
      'check.profile-identity',
      'check.plugin-installed',
      'check.plugin-enabled',
      'check.provider-registered',
      'check.provider-configurable',
      'check.credential-metadata',
      'check.model-catalog',
      'check.provider-diagnostic',
      'check.recent-error',
      'provider.workbuddy',
      'provider.workbuddy-ai',
      'provider.zcode-cli',
      'summary.healthy',
      'summary.broken',
      'summary.unresolved',
      'host.dshVersionSource.injected',
      'host.dshVersionSource.package-manifest',
      'host.dshVersionSource.unavailable',
    ]
    for (const key of required) expect(en[key], key).toBeTypeOf('string')
  })

  it('keeps placeholders consistent between languages', () => {
    for (const key of zhKeys as ProviderDoctorKey[]) {
      const placeholders = (text: string): string[] =>
        [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
      expect(placeholders(zh[key]), `zh.${key}`).toEqual(placeholders(en[key]))
    }
  })

  it('writes Chinese copy in Chinese and English copy without CJK characters', () => {
    const cjk = /[\u4e00-\u9fff]/
    // Product names and one-word technical labels are untranslated on purpose.
    const untranslated = new Set<ProviderDoctorKey>([
      'host.node',
      'host.profile',
      'host.dshHome',
      'provider.workbuddy',
      'provider.workbuddy-ai',
      'provider.zcode-cli',
      'footer.version',
    ])
    for (const key of zhKeys as ProviderDoctorKey[]) {
      if (untranslated.has(key)) continue
      expect(cjk.test(zh[key]), `zh.${key} should be Chinese`).toBe(true)
      expect(cjk.test(en[key]), `en.${key} should not contain Chinese`).toBe(false)
    }
  })
})
