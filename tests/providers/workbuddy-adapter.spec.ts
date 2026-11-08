import { describe, expect, it } from 'vitest'

import {
  credentialFrom,
  diagnosticFrom,
  interpretDoctor,
  isLaunchFailure,
  variantCliId,
  WORKBUDDY_ADAPTERS,
} from '../../src/providers/workbuddy/adapter.ts'
import type { WorkBuddyDoctorJson } from '../../src/providers/workbuddy/plugin-package.ts'

/** A signed-in doctor document. */
function doctor(overrides: Partial<WorkBuddyDoctorJson> = {}): WorkBuddyDoctorJson {
  return {
    pluginVersion: '0.1.14',
    signIn: 'signed-in',
    reasonCode: undefined,
    desktopAuthFormat: 'encrypted',
    desktopAuthPresent: true,
    hostHeartbeatPresent: true,
    hostHeartbeatProcessAlive: true,
    fallbackModels: 19,
    hint: undefined,
    ...overrides,
  }
}

describe('WORKBUDDY_ADAPTERS', () => {
  it('covers both WorkBuddy variants', () => {
    expect(WORKBUDDY_ADAPTERS.map((adapter) => adapter.id)).toEqual(['workbuddy', 'workbuddy-ai'])
  })

  it('names the plugin each variant belongs to', () => {
    for (const adapter of WORKBUDDY_ADAPTERS) {
      expect(adapter.pluginName).toBe('dsh-workbuddy-connect-community')
    }
  })

  it('promises the eight chain checks', () => {
    expect(WORKBUDDY_ADAPTERS[0]?.checks).toEqual([
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
})

describe('variantCliId', () => {
  it('maps the AI variant to its own CLI provider id', () => {
    expect(variantCliId('workbuddy-ai')).toBe('workbuddy-ai')
  })

  it('maps the main variant to workbuddy', () => {
    expect(variantCliId('workbuddy')).toBe('workbuddy')
  })
})

describe('interpretDoctor', () => {
  it('turns a document into a credential check and a diagnostic check', () => {
    const pair = interpretDoctor({ kind: 'json', value: doctor() }, 'workbuddy')
    expect(pair.credential.id).toBe('credential-metadata')
    expect(pair.diagnostic.id).toBe('provider-diagnostic')
    expect(pair.credential.status).toBe('pass')
    expect(pair.diagnostic.status).toBe('pass')
  })

  it('accepts a document that names the variant being checked', () => {
    const pair = interpretDoctor({ kind: 'json', value: { ...doctor(), provider: 'workbuddy' } }, 'workbuddy')
    expect(pair.credential.status).toBe('pass')
  })

  it('does not accept a document written for the other variant', () => {
    const pair = interpretDoctor({ kind: 'json', value: { provider: 'workbuddy-ai' } }, 'workbuddy')
    // Nothing was read, so neither check may claim an observation.
    expect(pair.credential.evidenceKind).not.toBe('observed')
    expect(pair.diagnostic.evidenceKind).not.toBe('observed')
    expect(pair.credential.reasonCode).toBe('unsupported')
    expect(JSON.stringify(pair)).not.toMatch(/signed out/i)
  })

  it('reports a missing CLI without pretending the credential was read', () => {
    const pair = interpretDoctor({ kind: 'missing' }, 'workbuddy')
    expect(pair.credential.status).toBe('unknown')
    expect(pair.credential.reasonCode).toBe('diagnostic_cli_missing')
    expect(JSON.stringify(pair.credential)).not.toMatch(/signed out/i)
  })

  it('reports a timeout as a timeout, never as a sign-out', () => {
    const pair = interpretDoctor({ kind: 'timeout' }, 'workbuddy')
    expect(pair.credential.status).toBe('timeout')
    expect(pair.credential.reasonCode).toBe('timed_out')
    expect(pair.credential.summary).toContain('not a sign-out')
  })

  it('reports a cancellation as cancelled', () => {
    const pair = interpretDoctor({ kind: 'cancelled' }, 'workbuddy')
    expect(pair.credential.status).toBe('cancelled')
    expect(pair.credential.reasonCode).toBe('cancelled')
    expect(pair.diagnostic.status).toBe('cancelled')
  })

  it('does not blame the account when the CLI never started', () => {
    // Measured on a real profile: without its @deepseek-ai peers the provider's
    // bin dies on module resolution before reading any credential.
    const pair = interpretDoctor(
      {
        kind: 'failed',
        message:
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-home-paths' imported from D:\\profiles\\pd-accept\\node_modules\\dsh-workbuddy-connect-community\\lib\\bin.js",
        stdout: '',
        stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-home-paths'",
      },
      'workbuddy',
    )
    expect(pair.credential.reasonCode).toBe('diagnostic_cli_unloadable')
    expect(pair.diagnostic.reasonCode).toBe('diagnostic_cli_unloadable')
    expect(pair.credential.summary).toContain('could not start')
    expect(JSON.stringify(pair)).not.toMatch(/signed out/i)
  })

  it('keeps the signed-out hint when the CLI ran but printed nothing usable', () => {
    const pair = interpretDoctor(
      { kind: 'failed', message: 'the diagnostic printed no JSON document', stdout: '', stderr: '' },
      'workbuddy',
    )
    expect(pair.credential.reasonCode).toBe('signed_out')
    expect(pair.diagnostic.reasonCode).toBe('internal_error')
  })
})

describe('isLaunchFailure', () => {
  it('recognises the several spellings Node uses for an unloadable import', () => {
    for (const message of [
      'Error [ERR_MODULE_NOT_FOUND]: Cannot find package "@deepseek-ai/dsh-llm"',
      "Error: Cannot find module 'D:\\x\\lib\\bin.js'",
    ]) {
      expect(isLaunchFailure({ message })).toBe(true)
    }
  })

  it('does not claim a launch failure from an ordinary diagnostic complaint', () => {
    expect(isLaunchFailure({ message: 'the provider is signed out' })).toBe(false)
    expect(isLaunchFailure({ message: 'no JSON', stderr: 'warning: region mismatch' })).toBe(false)
  })
})

describe('credentialFrom', () => {
  it('passes when WorkBuddy reports a resolved credential', () => {
    const check = credentialFrom(doctor(), 'workbuddy')
    expect(check).toMatchObject({ id: 'credential-metadata', status: 'pass', evidenceKind: 'observed' })
    expect(check.reasonCode).toBeUndefined()
    expect(check.details).toMatchObject({
      provider: 'workbuddy',
      desktopAuthFormat: 'encrypted',
      desktopAuthPresent: true,
      hostHeartbeatPresent: true,
    })
  })

  it('does not claim the credential was verified', () => {
    const check = credentialFrom(doctor(), 'workbuddy')
    expect(JSON.stringify(check).toLowerCase()).not.toMatch(/verified|token is valid/)
  })

  it('fails with credential_missing when nobody signed in', () => {
    const check = credentialFrom(doctor({ signIn: 'signed-out', reasonCode: 'no-credential' }), 'workbuddy')
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'credential_missing' })
  })

  it('fails with credential_unreadable for an unreadable sealed credential', () => {
    const check = credentialFrom(
      doctor({ signIn: 'signed-out', reasonCode: 'encrypted-credential-unreadable' }),
      'workbuddy',
    )
    expect(check.reasonCode).toBe('credential_unreadable')
  })

  it('fails with credential_region_mismatch', () => {
    const check = credentialFrom(doctor({ signIn: 'signed-out', reasonCode: 'credential-region-mismatch' }), 'workbuddy')
    expect(check.reasonCode).toBe('credential_region_mismatch')
  })

  it('explains that an Electron discovery reason is not a sign-out', () => {
    const check = credentialFrom(doctor({ signIn: 'signed-out', reasonCode: 'electron-binary-not-found' }), 'workbuddy')
    expect(check.status).toBe('fail')
    expect(check.summary.toLowerCase()).toContain('desktop app')
    expect(check.summary.toLowerCase()).not.toContain('sign out')
  })

  it('is unknown, not failing, when the CLI itself reported an error', () => {
    const check = credentialFrom(doctor({ signIn: 'error', reasonCode: 'internal-error' }), 'workbuddy')
    expect(check.status).toBe('unknown')
  })

  it('always offers a next step', () => {
    for (const reasonCode of [
      'no-credential',
      'encrypted-credential-unreadable',
      'credential-region-mismatch',
      'electron-binary-not-found',
      'electron-path-invalid',
      'something-new',
    ] as const) {
      const check = credentialFrom(doctor({ signIn: 'signed-out', reasonCode }), 'workbuddy')
      expect(check.nextSteps.length, reasonCode).toBeGreaterThan(0)
    }
  })

  it('never prints a path or a pid', () => {
    const check = credentialFrom(
      doctor({ signIn: 'signed-out', reasonCode: 'electron-binary-not-found' }),
      'workbuddy',
    )
    expect(JSON.stringify(check)).not.toMatch(/[A-Za-z]:\\\\|"pid"/)
  })
})

describe('diagnosticFrom', () => {
  it('passes when the provider diagnostic reports no internal problem', () => {
    const check = diagnosticFrom(doctor(), 'workbuddy')
    expect(check).toMatchObject({ id: 'provider-diagnostic', status: 'pass' })
    expect(check.details).toMatchObject({ hostBundleProcessAlive: true, signIn: 'signed-in' })
  })

  it('does not infer current registration from a stale shared heartbeat', () => {
    const check = diagnosticFrom(doctor({ hostHeartbeatProcessAlive: false }), 'workbuddy')
    expect(check).toMatchObject({ status: 'pass' })
    expect(check.reasonCode).toBeUndefined()
    expect(check.details).toMatchObject({ hostBundleProcessAlive: false })
    expect(JSON.stringify(check)).not.toMatch(/routes will not answer|Reload DSH/)
  })

  it('fails when the CLI ran but reported an error', () => {
    const check = diagnosticFrom(doctor({ signIn: 'error', reasonCode: 'internal-error' }), 'workbuddy')
    expect(check).toMatchObject({ status: 'fail', reasonCode: 'internal_error' })
  })

  it('does not report a missing heartbeat as a failure of the plugin', () => {
    const check = diagnosticFrom(doctor({ hostHeartbeatPresent: false, hostHeartbeatProcessAlive: false }), 'workbuddy')
    expect(check.status).toBe('pass')
    expect(check.reasonCode).toBeUndefined()
  })

  it('keeps the fallback model count for context', () => {
    expect(diagnosticFrom(doctor({ fallbackModels: 3 }), 'workbuddy').details).toMatchObject({ fallbackModels: 3 })
  })

  it('says so when the CLI itself reported that no host bundle is running', () => {
    const check = diagnosticFrom(doctor({ hint: 'host-bundle-not-running' }), 'workbuddy')
    expect(check).toMatchObject({ status: 'pass' })
    expect(check.reasonCode).toBeUndefined()
    expect(check.summary).toMatch(/no host bundle is currently running/i)
    expect(check.details).toMatchObject({ hostBundleHint: 'not-running' })
  })

  it('does not mention a host bundle when the CLI printed no such hint', () => {
    const check = diagnosticFrom(doctor(), 'workbuddy')
    expect(check.summary).not.toMatch(/host bundle is currently running/i)
    expect(check.details).not.toHaveProperty('hostBundleHint')
  })
})
