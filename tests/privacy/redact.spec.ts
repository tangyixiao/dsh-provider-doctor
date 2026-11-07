import { describe, expect, it } from 'vitest'

import { formatShareableReport, REDACTED, redactText, redactValue, toShareableReport } from '../../src/privacy/redact.ts'
import type { DiagnosticReport } from '../../src/shared/contract.ts'

/** A check literal before the module under test stamps it with a time. */
type CheckDraft = Omit<DiagnosticReport['checks'][number], 'observedAt'>

/** Build a report with the checks a shareable document reduces. */
function reportWith(checks: readonly CheckDraft[]): DiagnosticReport {
  return {
    schemaVersion: 1,
    provider: 'workbuddy',
    plugin: { name: 'dsh-workbuddy-connect-community', version: '0.1.14' },
    profile: { kind: 'live_host', identity: 'desktop' },
    host: { dshVersion: '0.2.2-rc.1', nodeVersion: 'v26.9.0', platform: 'win32', arch: 'x64' },
    checks: checks.map((check) => ({ ...check, observedAt: '2026-11-06T23:00:00.000Z' })),
    observedAt: '2026-11-06T23:00:00.000Z',
  }
}

describe('redactText', () => {
  it('leaves already-clean text alone', () => {
    expect(redactText('the provider is signed in')).toBe('the provider is signed in')
  })

  it('removes a JWT', () => {
    const text = 'failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl'
    expect(redactText(text)).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('removes an sk-style key', () => {
    expect(redactText('key sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('keeps the parameter name and drops the value', () => {
    const out = redactText('GET /callback?code=abc123&state=x')
    expect(out).toContain('code=')
    expect(out).not.toContain('abc123')
  })

  it('drops a bearer token but keeps the scheme word', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnop')
    expect(out).toContain('Bearer')
    expect(out).not.toContain('abcdefghijklmnop')
  })

  it('drops a Windows absolute path', () => {
    const out = redactText('settings at C:\\Users\\tangy\\.dsh\\profiles\\desktop')
    expect(out).not.toContain('tangy')
    expect(out).toContain(REDACTED)
  })

  it('drops a POSIX absolute path', () => {
    const out = redactText('reading /home/tangy/.dsh/profiles/desktop/cordis.yml')
    expect(out).not.toContain('tangy')
  })

  it('drops a home-relative path', () => {
    const out = redactText('wrote ~/.dsh/compatibility.json')
    expect(out).not.toContain('compatibility.json')
  })

  it('drops an email address', () => {
    expect(redactText('owner 37662981@qq.com signed in')).not.toContain('37662981')
  })

  it('drops a long opaque run', () => {
    const token = 'a'.repeat(60)
    expect(redactText(`value ${token} end`)).not.toContain(token)
  })

  it('truncates runaway text so one message cannot fill a report', () => {
    // Word-shaped text, so the long-token rule does not swallow it whole.
    const out = redactText('the provider said no '.repeat(40))
    expect(out.length).toBeLessThanOrEqual(400)
    expect(out.endsWith('...')).toBe(true)
  })

  it('replaces one enormous token wholesale rather than truncating it', () => {
    expect(redactText('x'.repeat(900))).toBe(REDACTED)
  })

  it('is total: empty and odd inputs return strings', () => {
    expect(redactText('')).toBe('')
    expect(typeof redactText(':////')).toBe('string')
  })
})

describe('redactValue', () => {
  it('passes primitives through unchanged', () => {
    expect(redactValue(3)).toBe(3)
    expect(redactValue(true)).toBe(true)
    expect(redactValue(null)).toBeNull()
  })

  it('keeps array length', () => {
    const out = redactValue(['C:\\a\\b.txt', 'plain']) as string[]
    expect(out).toHaveLength(2)
    expect(out[1]).toBe('plain')
  })

  it('keeps object keys and redacts values', () => {
    const out = redactValue({ path: '/home/x/.dsh/a.json', ok: false }) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(['ok', 'path'])
    expect(out['ok']).toBe(false)
    expect(out['path']).toBe(REDACTED)
  })

  it('stops at the depth cap instead of recursing forever', () => {
    let deep: unknown = 'leaf'
    for (let index = 0; index < 12; index += 1) deep = { next: deep }
    expect(() => redactValue(deep)).not.toThrow()
  })
})

describe('toShareableReport', () => {
  const checks: CheckDraft[] = [
    {
      id: 'plugin-installed',
      status: 'pass',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: 'offline',
      summary: 'installed at C:\\Users\\tangy\\.dsh',
      nextSteps: [],
    },
    {
      id: 'plugin-enabled',
      status: 'fail',
      evidenceKind: 'observed',
      source: 'live_host',
      cost: 'offline',
      reasonCode: 'plugin_disabled',
      summary: 'disabled for user 37662981@qq.com',
      nextSteps: ['enable it'],
    },
    {
      id: 'provider-registered',
      status: 'unknown',
      evidenceKind: 'unavailable',
      source: 'fallback',
      cost: 'offline',
      reasonCode: 'llm_unavailable',
      summary: 'no llm service',
      nextSteps: [],
    },
    {
      id: 'model-catalog',
      status: 'not_checked',
      evidenceKind: 'unavailable',
      source: 'provider_diagnostic',
      cost: 'side_effecting',
      reasonCode: 'not_requested',
      summary: 'skipped',
      nextSteps: [],
    },
  ]

  it('carries only whitelisted fields', () => {
    const shared = toShareableReport([reportWith(checks)], {
      version: '0.1.0',
      runtime: 'v26.9.0',
      platform: 'win32',
      architecture: 'x64',
    })
    expect(shared.schemaVersion).toBe(1)
    expect(shared.package).toBe('dsh-provider-doctor')
    expect(shared.reports).toHaveLength(1)
    const entry = shared.reports[0]
    expect(entry?.provider).toBe('workbuddy')
    expect(entry?.checks.map((check) => check.id)).toEqual([
      'plugin-installed',
      'plugin-enabled',
      'provider-registered',
      'model-catalog',
    ])
  })

  it('drops summaries, next steps, details, paths and timestamps', () => {
    const serialised = JSON.stringify(
      toShareableReport([reportWith(checks)], {
        version: '0.1.0',
        runtime: 'v26.9.0',
        platform: 'win32',
        architecture: 'x64',
      }),
    )
    expect(serialised).not.toContain('tangy')
    expect(serialised).not.toContain('37662981')
    expect(serialised).not.toContain('enable it')
    expect(serialised).not.toContain('2026-11-06')
  })

  it('reduces readiness to fixed vocabulary', () => {
    const entry = toShareableReport([reportWith(checks)], {
      version: '0.1.0',
      runtime: 'v26.9.0',
      platform: 'win32',
      architecture: 'x64',
    }).reports[0]
    expect(entry?.readiness).toEqual({
      installed: 'installed',
      enabled: 'disabled',
      registration: 'unknown',
      catalog: 'not-tested',
      liveInference: 'not-tested',
    })
  })

  it('drops an unrecognised reason code rather than publishing it', () => {
    const smuggled = reportWith([
      {
        id: 'plugin-enabled',
        status: 'fail',
        evidenceKind: 'observed',
        source: 'live_host',
        cost: 'offline',
        reasonCode: 'error from /home/x token=abc',
        summary: 'bad',
        nextSteps: [],
      },
    ])
    const entry = toShareableReport([smuggled], {
      version: '0.1.0',
      runtime: 'v26.9.0',
      platform: 'win32',
      architecture: 'x64',
    }).reports[0]
    expect(entry?.checks[0]?.reasonCode).toBeUndefined()
  })

  it('reports unknown readiness when a link has no check at all', () => {
    const entry = toShareableReport([reportWith([])], {
      version: '0.1.0',
      runtime: 'v26.9.0',
      platform: 'win32',
      architecture: 'x64',
    }).reports[0]
    expect(entry?.readiness.installed).toBe('unknown')
    expect(entry?.readiness.catalog).toBe('unknown')
  })
})

describe('formatShareableReport', () => {
  it('renders one line per check and never the summary', () => {
    const text = formatShareableReport(
      toShareableReport(
        [
          reportWith([
            {
              id: 'plugin-enabled',
              status: 'fail',
              evidenceKind: 'observed',
              source: 'live_host',
              cost: 'offline',
              reasonCode: 'plugin_disabled',
              summary: 'secret summary text',
              nextSteps: [],
            },
          ]),
        ],
        { version: '0.1.0', runtime: 'v26.9.0', platform: 'win32', architecture: 'x64' },
      ),
    )
    expect(text).toContain('dsh-provider-doctor 0.1.0')
    expect(text).toContain('plugin-enabled: fail/observed via live_host (plugin_disabled)')
    expect(text).not.toContain('secret summary text')
  })
})
