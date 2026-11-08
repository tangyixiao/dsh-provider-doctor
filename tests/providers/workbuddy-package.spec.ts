import { describe, expect, it } from 'vitest'

import {
  extractJsonObject,
  isWorkBuddyCliReasonCode,
  readDoctorJson,
  readShareJson,
  workBuddyReasonFor,
  workbuddyVariantFor,
  WORKBUDDY_CLI_REASON_CODES,
  WORKBUDDY_PACKAGE,
  WORKBUDDY_VARIANTS,
} from '../../src/providers/workbuddy/plugin-package.ts'

/** A `doctor --json` document as WorkBuddy 0.1.15 prints it. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    package: 'dsh-workbuddy-connect-community',
    version: '0.1.15',
    node: 'v26.9.0',
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    desktopAuthFile: {
      path: 'C:\\Users\\someone\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info',
      present: true,
      format: 'encrypted',
    },
    ownAuthFile: 'D:\\home\\.workbuddy-auth.json',
    hostHeartbeat: {
      path: 'D:\\home\\.workbuddy-community-host-heartbeat.json',
      present: true,
      registeredAt: 1794056774920,
      pid: 39896,
      processAlive: false,
    },
    signIn: 'signed-in',
    fallbackModels: 19,
    hints: [],
    ...overrides,
  }
}

describe('WORKBUDDY_PACKAGE', () => {
  it('names the package that owns both routes', () => {
    expect(WORKBUDDY_PACKAGE).toBe('dsh-workbuddy-connect-community')
  })
})

describe('workbuddyVariantFor', () => {
  it('finds both variants', () => {
    expect(workbuddyVariantFor('workbuddy')?.cliProviderId).toBe('workbuddy')
    expect(workbuddyVariantFor('workbuddy-ai')?.cliProviderId).toBe('workbuddy-ai')
  })

  it('returns undefined for an unknown id', () => {
    expect(workbuddyVariantFor('zcode-cli')).toBeUndefined()
  })

  it('lists both variants in registration order', () => {
    expect(WORKBUDDY_VARIANTS.map(variant => variant.id)).toEqual(['workbuddy', 'workbuddy-ai'])
  })
})

describe('WORKBUDDY_CLI_REASON_CODES', () => {
  it('is the closed set the plugin documents', () => {
    expect([...WORKBUDDY_CLI_REASON_CODES]).toEqual([
      'no-credential',
      'encrypted-credential-unreadable',
      'electron-binary-not-found',
      'electron-binary-ambiguous',
      'electron-binary-unavailable',
      'electron-path-invalid',
      'electron-discovery-incomplete',
      'credential-region-mismatch',
    ])
  })

  it('accepts a documented code and rejects anything else', () => {
    expect(isWorkBuddyCliReasonCode('no-credential')).toBe(true)
    expect(isWorkBuddyCliReasonCode('something-new')).toBe(false)
    expect(isWorkBuddyCliReasonCode(undefined)).toBe(false)
    expect(isWorkBuddyCliReasonCode(7)).toBe(false)
  })
})

describe('workBuddyReasonFor', () => {
  it('maps the credential codes onto the shared vocabulary', () => {
    expect(workBuddyReasonFor('no-credential')).toBe('credential_missing')
    expect(workBuddyReasonFor('credential-region-mismatch')).toBe('credential_region_mismatch')
    expect(workBuddyReasonFor('encrypted-credential-unreadable')).toBe('credential_unreadable')
  })

  it('treats an Electron discovery failure as an internal error, not a credential one', () => {
    expect(workBuddyReasonFor('electron-binary-not-found')).toBe('internal_error')
    expect(workBuddyReasonFor('electron-discovery-incomplete')).toBe('internal_error')
  })

  it('falls back to an internal error for an unknown or absent code', () => {
    expect(workBuddyReasonFor('brand-new-code')).toBe('internal_error')
    expect(workBuddyReasonFor(undefined)).toBe('internal_error')
  })
})

describe('extractJsonObject', () => {
  it('reads a document printed on its own', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('skips a human-readable preamble', () => {
    expect(extractJsonObject('checking...\n{"a":1}\ndone')).toEqual({ a: 1 })
  })

  it('keeps braces that live inside strings', () => {
    expect(extractJsonObject('{"path":"C:\\\\a}b","ok":true}')).toEqual({ path: 'C:\\a}b', ok: true })
  })

  it('skips an unparseable candidate and keeps scanning', () => {
    expect(extractJsonObject('{ broken }\n{"a":2}')).toEqual({ a: 2 })
  })

  it('returns undefined when nothing parses', () => {
    expect(extractJsonObject('no document here')).toBeUndefined()
    expect(extractJsonObject('{"a":')).toBeUndefined()
  })
})

describe('readDoctorJson', () => {
  it('keeps the readable fields and drops every path', () => {
    const parsed = readDoctorJson(document())
    expect(parsed).toEqual({
      pluginVersion: '0.1.15',
      signIn: 'signed-in',
      reasonCode: undefined,
      desktopAuthFormat: 'encrypted',
      desktopAuthPresent: true,
      hostHeartbeatPresent: true,
      hostHeartbeatProcessAlive: false,
      fallbackModels: 19,
      hint: undefined,
    })
  })

  it('never exposes a path or a pid, even from the raw document', () => {
    const parsed = readDoctorJson(document({ hints: ['No WorkBuddy desktop auth file at D:\\secret\\path.'] }))
    const text = JSON.stringify(parsed)
    expect(text).not.toContain('AppData')
    expect(text).not.toContain('39896')
    expect(text).not.toContain('secret')
  })

  it('collapses the host-bundle hint onto a fixed token', () => {
    const parsed = readDoctorJson(
      document({ hints: ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'] }),
    )
    expect(parsed?.hint).toBe('host-bundle-not-running')
  })

  it('drops a hint it does not recognise instead of echoing it', () => {
    const parsed = readDoctorJson(document({ hints: ['Sign in once in the WorkBuddy desktop app, then run status again.'] }))
    expect(parsed?.hint).toBeUndefined()
  })

  it('ignores a hints field that is not an array of strings', () => {
    expect(readDoctorJson(document({ hints: 'not-a-list' }))?.hint).toBeUndefined()
    expect(readDoctorJson(document({ hints: [42] }))?.hint).toBeUndefined()
  })

  it('rejects a document for another provider', () => {
    expect(readDoctorJson(document({ provider: 'workbuddy-ai-future' }))).toBeUndefined()
  })

  it('accepts the other variant', () => {
    expect(readDoctorJson(document({ provider: 'workbuddy-ai' }))?.signIn).toBe('signed-in')
  })

  it('accepts a document that names no provider', () => {
    const raw = document()
    delete raw['provider']
    expect(readDoctorJson(raw)?.signIn).toBe('signed-in')
  })

  it('rejects a value that is not an object', () => {
    expect(readDoctorJson('{"a":1}')).toBeUndefined()
    expect(readDoctorJson([1, 2])).toBeUndefined()
    expect(readDoctorJson(null)).toBeUndefined()
  })

  it('reports missing fields as undefined rather than inventing them', () => {
    const parsed = readDoctorJson({ provider: 'workbuddy' })
    expect(parsed).toEqual({
      pluginVersion: undefined,
      signIn: undefined,
      reasonCode: undefined,
      desktopAuthFormat: undefined,
      desktopAuthPresent: undefined,
      hostHeartbeatPresent: undefined,
      hostHeartbeatProcessAlive: undefined,
      fallbackModels: undefined,
      hint: undefined,
    })
  })
})

describe('readShareJson', () => {
  it('keeps the fixed-vocabulary readiness block', () => {
    const parsed = readShareJson({
      schemaVersion: 1,
      package: 'dsh-workbuddy-connect-community',
      version: '0.1.15',
      provider: 'workbuddy',
      desktopAuthFile: { present: true, format: 'encrypted' },
      signIn: 'signed-in',
      hostHeartbeat: { present: true, processAlive: true },
      fallbackModels: 19,
      readiness: { authentication: 'credential-found', host: 'running', liveInference: 'not-tested' },
    })
    expect(parsed?.readiness).toEqual({
      authentication: 'credential-found',
      host: 'running',
      liveInference: 'not-tested',
    })
    expect(parsed?.signIn).toBe('signed-in')
  })

  it('keeps the failure document readable', () => {
    const parsed = readShareJson({ provider: 'workbuddy', errorCode: 'diagnostic-unavailable' })
    expect(parsed?.errorCode).toBe('diagnostic-unavailable')
  })

  it('rejects a document for another provider', () => {
    expect(readShareJson({ provider: 'zcode-cli' })).toBeUndefined()
  })
})
