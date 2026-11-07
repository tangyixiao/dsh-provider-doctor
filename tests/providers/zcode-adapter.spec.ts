import { describe, expect, it } from 'vitest'

import {
  credentialFrom,
  credentialReason,
  diagnosticCheckFrom,
  diagnosticFrom,
  readSummary,
  ZCODE_ADAPTER,
  ZCODE_PACKAGE,
  ZCODE_PROVIDER,
} from '../../src/providers/zcode/adapter.ts'
import type { ZcodeDoctorSummary } from '../../src/providers/zcode/adapter.ts'

/** A healthy `doctor --json` summary. */
function summary(overrides: {
  ok?: boolean
  facts?: Record<string, unknown>
  command?: string | undefined
} = {}): ZcodeDoctorSummary {
  return {
    command: overrides.command ?? 'doctor',
    ok: overrides.ok ?? true,
    facts: overrides.facts ?? {
      node: 'v24.21.0',
      zcodeCliPath: 'C:\\npm-global\\node_modules\\zcode-app-cli\\vendor\\zcode.cjs',
      builtin: { version: '1.4.2', source: 'bundled', revision: 'abc123' },
      credentials: { planTokenLength: 512, activeProvider: 'zai' },
      catalog: [{ providerId: 'zai', modelId: 'glm-4.6', contextWindow: 200000 }],
    },
  }
}

describe('adapter identity', () => {
  it('checks the eight chain steps for this plugin', () => {
    expect(ZCODE_ADAPTER.checks).toEqual([
      'plugin-installed',
      'plugin-enabled',
      'provider-registered',
      'provider-configurable',
      'credential-metadata',
      'model-catalog',
      'provider-diagnostic',
      'recent-error',
    ])
  })

  it('declares the provider id the bridge registers', () => {
    expect(ZCODE_ADAPTER.id).toBe('zcode-cli')
    expect(ZCODE_PROVIDER).toBe('zcode-cli')
  })

  it('declares the package that owns the provider', () => {
    expect(ZCODE_ADAPTER.pluginName).toBe('dsh-zcode-plan-bridge')
    expect(ZCODE_PACKAGE).toBe('dsh-zcode-plan-bridge')
  })
})

describe('readSummary', () => {
  it('reads a well-formed document', () => {
    expect(readSummary({ command: 'doctor', ok: true, facts: { node: 'v24' } })).toEqual({
      command: 'doctor',
      ok: true,
      facts: { node: 'v24' },
    })
  })

  it('refuses a document without an ok flag', () => {
    expect(readSummary({ command: 'doctor', facts: {} })).toBeUndefined()
    expect(readSummary({ ok: 'yes', facts: {} })).toBeUndefined()
  })

  it('refuses a non-object document', () => {
    for (const value of [null, undefined, 42, 'text', [1, 2]]) {
      expect(readSummary(value)).toBeUndefined()
    }
  })

  it('treats a missing or malformed facts block as empty rather than failing', () => {
    expect(readSummary({ ok: true })?.facts).toEqual({})
    expect(readSummary({ ok: true, facts: [] })?.facts).toEqual({})
  })

  it('drops a non-string command without dropping the document', () => {
    expect(readSummary({ ok: false, command: 7 })?.command).toBeUndefined()
  })
})

describe('credentialReason', () => {
  it('maps a missing credential file', () => {
    expect(credentialReason('ENOENT')).toBe('credential_missing')
  })

  it('maps an unreadable credential file', () => {
    expect(credentialReason('EACCES')).toBe('credential_unreadable')
    expect(credentialReason('EPERM')).toBe('credential_unreadable')
    expect(credentialReason('EISDIR')).toBe('credential_unreadable')
  })

  it('treats an unrecognised failure as signed out, never as a pass', () => {
    expect(credentialReason('SOMETHING_ELSE')).toBe('signed_out')
    expect(credentialReason(undefined)).toBe('signed_out')
  })
})

describe('credentialFrom', () => {
  it('passes when the CLI read a plan token', () => {
    const check = credentialFrom(summary())
    expect(check).toMatchObject({ id: 'credential-metadata', status: 'pass', evidenceKind: 'observed' })
    expect(check.details).toMatchObject({ provider: 'zcode-cli', activeProvider: 'zai' })
  })

  it('never claims the token is valid', () => {
    const check = credentialFrom(summary())
    expect(JSON.stringify(check).toLowerCase()).not.toMatch(/verified|is valid|is valid now/)
    expect(check.summary).toContain('not tested')
  })

  it('never prints the token or its path', () => {
    const text = JSON.stringify(credentialFrom(summary()))
    expect(text).not.toContain('planToken"')
    expect(text).not.toContain('zcode.cjs')
  })

  it('fails with credential_missing when the CLI read no token', () => {
    const check = credentialFrom(summary({ facts: { credentials: { planTokenLength: 0 } } }))
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'credential_missing' })
  })

  it('maps a credential error code onto the vocabulary', () => {
    const check = credentialFrom(summary({ facts: { credentials: { error: 'EACCES' } } }))
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'credential_unreadable' })
  })

  it('fails with credential_missing when the CLI reported no credential at all', () => {
    const check = credentialFrom(summary({ facts: {} }))
    expect(check.status).toBe('fail')
    expect(check.reasonCode).toBe('credential_missing')
  })

  it('carries the builtin version as context, not as a secret', () => {
    const check = credentialFrom(summary())
    expect(check.details?.['builtinVersion']).toBe('1.4.2')
  })

  it('always offers a next step when it does not pass', () => {
    for (const facts of [{}, { credentials: { planTokenLength: 0 } }, { credentials: { error: 'ENOENT' } }]) {
      const check = credentialFrom(summary({ facts }))
      expect(check.nextSteps.length).toBeGreaterThan(0)
    }
  })

  it('omits next steps when it passes', () => {
    expect(credentialFrom(summary()).nextSteps).toEqual([])
  })
})

describe('diagnosticFrom', () => {
  it('passes when the CLI finished its own checks', () => {
    const check = diagnosticFrom(summary())
    expect(check).toMatchObject({ id: 'provider-diagnostic', status: 'pass', evidenceKind: 'observed' })
    expect(check.reasonCode).toBeUndefined()
  })

  it('fails when the CLI reported a failing step', () => {
    const check = diagnosticFrom(summary({ ok: false, facts: { node: 'v20.1.0' } }))
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'cli_runtime_unreadable' })
  })

  it('reports the CLI node version as context', () => {
    expect(diagnosticFrom(summary()).details?.['cliNodeVersion']).toBe('v24.21.0')
  })

  it('reports whether a CLI path was located without printing it', () => {
    const check = diagnosticFrom(summary())
    expect(check.details?.['cliLocated']).toBe(true)
    expect(JSON.stringify(check)).not.toContain('zcode.cjs')
  })

  it('reports the model count the CLI saw', () => {
    expect(diagnosticFrom(summary()).details?.['reportedModels']).toBe(1)
  })

  it('carries the builtin source without the revision path', () => {
    expect(diagnosticFrom(summary()).details?.['builtinSource']).toBe('bundled')
  })

  it('does not invent a catalog count when the CLI reported none', () => {
    expect(diagnosticFrom(summary({ facts: {} })).details?.['reportedModels']).toBeUndefined()
  })

  it('always offers a next step when it fails', () => {
    expect(diagnosticFrom(summary({ ok: false, facts: {} })).nextSteps.length).toBeGreaterThan(0)
  })
})

describe('diagnosticCheckFrom', () => {
  it('fails when a located CLI turned out to be unstartable', () => {
    const check = diagnosticCheckFrom({ kind: 'missing' })
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'diagnostic_cli_missing' })
    expect(check.evidenceKind).toBe('unavailable')
  })

  it('reports a timeout as a timeout', () => {
    const check = diagnosticCheckFrom({ kind: 'timeout' })
    expect(check).toMatchObject({ status: 'timeout', reasonCode: 'timed_out' })
    expect(JSON.stringify(check)).not.toMatch(/signed out/i)
  })

  it('reports a cancellation as cancelled', () => {
    expect(diagnosticCheckFrom({ kind: 'cancelled' })).toMatchObject({
      status: 'cancelled',
      reasonCode: 'cancelled',
    })
  })

  it('reports a CLI that printed an unrecognised document as unsupported', () => {
    const check = diagnosticCheckFrom({ kind: 'unreadable' })
    expect(check.status).toBe('fail')
    expect(check.reasonCode).toBe('unsupported')
    expect(check.nextSteps.length).toBeGreaterThan(0)
  })

  it('reports a crashed CLI as a failing diagnostic', () => {
    const check = diagnosticCheckFrom({ kind: 'failed', message: 'spawn failed' })
    expect(check.status).toBe('fail')
    expect(check.nextSteps.length).toBeGreaterThan(0)
  })

  it('forwards a readable summary to the diagnostic check', () => {
    expect(diagnosticCheckFrom({ kind: 'summary', summary: summary() }).status).toBe('pass')
  })
})
