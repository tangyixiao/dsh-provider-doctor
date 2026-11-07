// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText, formatShareable } from '../../src/client/api.ts'
import type { ShareableReport } from '../../src/shared/contract.ts'

/** A minimal shareable document. */
function report(overrides: Partial<ShareableReport> = {}): ShareableReport {
  return {
    schemaVersion: 1,
    package: 'dsh-provider-doctor',
    version: '0.1.0',
    runtime: 'v24.21.0',
    platform: 'win32',
    architecture: 'x64',
    reports: [
      {
        provider: 'workbuddy',
        readiness: {
          installed: 'installed',
          enabled: 'enabled',
          registration: 'registered',
          catalog: 'readable',
          liveInference: 'not-tested',
        },
        checks: [
          { id: 'plugin-installed', status: 'pass', evidenceKind: 'observed', source: 'live_host' },
          {
            id: 'credential-metadata',
            status: 'fail',
            evidenceKind: 'observed',
            source: 'provider_diagnostic',
            reasonCode: 'credential_missing',
          },
        ],
      },
    ],
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('formatShareable', () => {
  it('starts with the package, version and platform', () => {
    const text = formatShareable(report())
    expect(text.split('\n')[0]).toBe('dsh-provider-doctor 0.1.0 — win32/x64, v24.21.0')
  })

  it('writes one readiness line per provider', () => {
    const text = formatShareable(report())
    expect(text).toContain(
      'installed=installed enabled=enabled registration=registered catalog=readable liveInference=not-tested',
    )
  })

  it('writes one line per check with its status, evidence and source', () => {
    const text = formatShareable(report())
    expect(text).toContain('  - plugin-installed: pass/observed via live_host')
  })

  it('appends the reason code when the contract knows one', () => {
    expect(formatShareable(report())).toContain('credential-metadata: fail/observed via provider_diagnostic (credential_missing)')
  })

  it('omits a reason code the contract does not know', () => {
    const text = formatShareable(
      report({
        reports: [
          {
            provider: 'zcode-cli',
            readiness: {
              installed: 'missing',
              enabled: 'unknown',
              registration: 'missing',
              catalog: 'not-tested',
              liveInference: 'not-tested',
            },
            checks: [
              {
                id: 'plugin-installed',
                status: 'unknown',
                evidenceKind: 'unavailable',
                source: 'fallback',
                reasonCode: 'not-a-real-code',
              },
            ],
          },
        ],
      }),
    )
    expect(text).not.toContain('not-a-real-code')
  })

  it('matches the Host formatter exactly, so preview and clipboard cannot drift', async () => {
    const { formatShareableReport } = await import('../../src/privacy/redact.ts')
    const document = report()
    const host = formatShareableReport(document)
    expect(formatShareable(document)).toBe(host.trimEnd())
  })

  it('carries no summary, next step or path, because the document has none', () => {
    const text = formatShareable(report())
    expect(text).not.toMatch(/\\\\|C:\\|Users/)
  })
})

describe('copyText', () => {
  it('uses the clipboard API when the renderer offers one', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to the selection path when the clipboard API throws', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('permission denied')
        },
      },
    })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    // The helper must not leave its scratch node behind.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports failure when neither path works', async () => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', {
      value: () => {
        throw new Error('unsupported')
      },
      configurable: true,
    })
    await expect(copyText('hello')).resolves.toBe(false)
  })
})
