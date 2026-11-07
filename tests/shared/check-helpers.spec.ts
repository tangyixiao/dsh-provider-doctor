import { describe, expect, it } from 'vitest'

import {
  cancelled,
  describeError,
  fail,
  makeCheck,
  notChecked,
  pass,
  probeWithBudget,
  timedOut,
  unknown,
  warn,
} from '../../src/shared/check-helpers.ts'
import { isReasonCode } from '../../src/shared/reason-codes.ts'

describe('makeCheck', () => {
  it('stamps a real ISO instant when the caller does not pin one', () => {
    const check = pass({ id: 'provider-registered', evidenceKind: 'observed', source: 'live_host', summary: 'ok' })
    expect(Number.isNaN(Date.parse(check.observedAt))).toBe(false)
    expect(check.observedAt.endsWith('Z')).toBe(true)
  })

  it('honours a pinned observedAt so a report is reproducible', () => {
    const check = pass({
      id: 'host-runtime',
      evidenceKind: 'observed',
      source: 'live_host',
      summary: 'ok',
      observedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(check.observedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('defaults the cost to offline', () => {
    const check = pass({ id: 'plugin-installed', evidenceKind: 'observed', source: 'live_host', summary: 'ok' })
    expect(check.cost).toBe('offline')
  })

  it('drops a reason code from a passing check', () => {
    const check = makeCheck({
      id: 'plugin-enabled',
      status: 'pass',
      evidenceKind: 'observed',
      source: 'live_host',
      reasonCode: 'plugin_disabled',
      summary: 'ok',
    })
    expect(check.reasonCode).toBeUndefined()
  })

  it('invents internal_error rather than publishing an unknown code', () => {
    const check = makeCheck({
      id: 'plugin-enabled',
      status: 'fail',
      evidenceKind: 'observed',
      source: 'live_host',
      reasonCode: 'made_up_code' as never,
      summary: 'broke',
    })
    expect(check.reasonCode).toBe('internal_error')
  })

  it('invents internal_error when a failure carries no code at all', () => {
    const check = makeCheck({
      id: 'plugin-enabled',
      status: 'unknown',
      evidenceKind: 'unavailable',
      source: 'fallback',
      summary: 'no evidence',
    })
    expect(check.reasonCode).toBe('internal_error')
    expect(isReasonCode(check.reasonCode ?? '')).toBe(true)
  })

  it('keeps nextSteps present but empty by default', () => {
    const check = pass({ id: 'model-catalog', evidenceKind: 'observed', source: 'live_host', summary: 'ok' })
    expect(check.nextSteps).toEqual([])
  })

  it('redacts the summary and every next step', () => {
    const check = fail({
      id: 'credential-metadata',
      evidenceKind: 'observed',
      source: 'provider_diagnostic',
      reasonCode: 'credential_unreadable',
      summary: 'token=abc123 could not be read from C:\\Users\\someone\\secrets.json',
      nextSteps: ['open https://example.test/x?token=zzz'],
    })
    expect(check.summary).not.toContain('abc123')
    expect(check.summary).not.toContain('someone')
    expect(check.nextSteps.join(' ')).not.toContain('zzz')
  })

  it('redacts string values inside details without changing the shape', () => {
    const check = unknown({
      id: 'recent-error',
      evidenceKind: 'unavailable',
      source: 'local_metadata',
      reasonCode: 'no_recorded_attempt',
      summary: 'nothing recorded',
      details: { provider: 'workbuddy', nested: { path: 'D:\\npm-global\\thing.js' }, count: 3 },
    })
    expect(check.details).toEqual({
      provider: 'workbuddy',
      nested: { path: '[redacted]' },
      count: 3,
    })
  })
})

describe('the status constructors', () => {
  it('always names the timeout code', () => {
    const check = timedOut({ id: 'provider-diagnostic', evidenceKind: 'unavailable', source: 'provider_diagnostic', summary: 'slow' })
    expect(check.status).toBe('timeout')
    expect(check.reasonCode).toBe('timed_out')
  })

  it('always names the cancelled code', () => {
    const check = cancelled({ id: 'provider-diagnostic', evidenceKind: 'unavailable', source: 'provider_diagnostic', summary: 'stopped' })
    expect(check.status).toBe('cancelled')
    expect(check.reasonCode).toBe('cancelled')
  })

  it('defaults a skipped check to not_requested', () => {
    const check = notChecked({ id: 'credential-metadata', evidenceKind: 'unavailable', source: 'provider_diagnostic', summary: 'skipped' })
    expect(check.status).toBe('not_checked')
    expect(check.reasonCode).toBe('not_requested')
  })

  it('lets a skipped check name a structural reason instead', () => {
    const check = notChecked({
      id: 'plugin-enabled',
      evidenceKind: 'unavailable',
      source: 'live_host',
      reasonCode: 'inventory_unavailable',
      summary: 'no inventory',
    })
    expect(check.reasonCode).toBe('inventory_unavailable')
  })

  it('marks a degraded link as a warning, not a failure', () => {
    const check = warn({
      id: 'host-runtime',
      evidenceKind: 'observed',
      source: 'live_host',
      reasonCode: 'host_version_mismatch',
      summary: 'outside the verified range',
    })
    expect(check.status).toBe('warning')
  })
})

describe('probeWithBudget', () => {
  it('returns the value when the probe settles in time', async () => {
    const outcome = await probeWithBudget(async () => 'done', { budgetMs: 1_000, signal: new AbortController().signal })
    expect(outcome).toEqual({ kind: 'value', value: 'done' })
  })

  it('reports a timeout instead of throwing', async () => {
    const never = new Promise<string>(() => undefined)
    const outcome = await probeWithBudget(() => never, { budgetMs: 10, signal: new AbortController().signal })
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('lets a late resolution lose to the timeout it already reported', async () => {
    let release: ((value: string) => void) | undefined
    const slow = new Promise<string>((resolve) => {
      release = resolve
    })
    const outcome = await probeWithBudget(() => slow, { budgetMs: 5, signal: new AbortController().signal })
    release?.('too late')
    expect(outcome).toEqual({ kind: 'timeout' })
  })

  it('aborts the probe it gave up on', async () => {
    let sawAbort = false
    const never = new Promise<void>(() => undefined)
    const outcome = await probeWithBudget(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('aborted'))
          })
        }).then(() => never),
      { budgetMs: 5, signal: new AbortController().signal },
    )
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(sawAbort).toBe(true)
  })

  it('reports a thrown probe as an error outcome', async () => {
    const outcome = await probeWithBudget(
      async () => {
        throw new Error('boom')
      },
      { budgetMs: 1_000, signal: new AbortController().signal },
    )
    expect(outcome.kind).toBe('error')
  })

  it('does not start work when the outer signal already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = false
    const outcome = await probeWithBudget(
      async () => {
        started = true
        return 1
      },
      { budgetMs: 1_000, signal: controller.signal },
    )
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(started).toBe(false)
  })
})

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('nope'))).toBe('nope')
  })

  it('falls back to the name when the message is empty', () => {
    expect(describeError(new TypeError(''))).toBe('TypeError')
  })

  it('passes a string through', () => {
    expect(describeError('plain')).toBe('plain')
  })

  it('serialises a plain object', () => {
    expect(describeError({ code: 'E_X' })).toBe('{"code":"E_X"}')
  })

  it('never throws on a value it cannot serialise', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(typeof describeError(cyclic)).toBe('string')
  })
})
