/**
 * End-to-end tests for the ZCode adapter's `diagnose()`.
 *
 * These are deliberately not mock-based. The risk being covered is a
 * *behavioural* one: whether the offline run really starts nothing, and whether
 * the connection run really is allowed to. A stubbed module would only prove
 * that the code calls what it calls; a real child process proves the outcome.
 *
 * @module tests/providers/zcode-diagnose
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ZCODE_ADAPTER } from '../../src/providers/zcode/adapter.ts'
import type { AdapterContext, LlmLike, ModelInfoLike } from '../../src/providers/types.ts'

const PACKAGE = 'dsh-zcode-plan-bridge'
const scratch: string[] = []

/** The doctor JSON the fake CLI prints instead of starting a real app-server. */
const FAKE_DOCTOR = {
  command: 'doctor',
  ok: true,
  facts: {
    node: 'v26.9.0',
    zcodeCliPath: 'C:\\fake\\zcode.cjs',
    builtin: { version: '3.17.1', source: 'bundled', revision: 'abc123' },
    credentials: { planTokenLength: 42, activeProvider: 'zai' },
    catalog: [
      { providerId: 'zai', modelId: 'glm-5', contextWindow: 200_000, maxOutputTokens: 8_000 },
      { providerId: 'zai', modelId: 'glm-5-air', contextWindow: 128_000, maxOutputTokens: 8_000 },
    ],
  },
}

/**
 * Build a throwaway profile whose plugin CLI is a tiny Node script.
 *
 * The script records every launch in {@link marker} so a test can assert that a
 * path started no process at all, rather than merely that it asked for no data.
 */
function fakeProfile(): { profileDir: string; marker: string } {
  const profileDir = mkdtempSync(join(tmpdir(), 'pd-zcode-diagnose-'))
  scratch.push(profileDir)
  const marker = join(profileDir, 'launched.txt')
  const packageDir = join(profileDir, 'node_modules', PACKAGE)
  mkdirSync(packageDir, { recursive: true })

  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '0.6.0',
      bin: { [PACKAGE]: './bin.js' },
    }),
  )
  writeFileSync(
    join(packageDir, 'bin.js'),
    [
      "const { appendFileSync } = require('node:fs')",
      'appendFileSync(' + JSON.stringify(marker) + ", 'launched\\n')",
      'process.stdout.write(' + JSON.stringify(JSON.stringify(FAKE_DOCTOR)) + ')',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'pd-scratch',
      dependencies: { [PACKAGE]: '^0.6.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
  )
  return { profileDir, marker }
}

/** An llm service that records whether the catalog was ever asked for. */
function recordingLlm(): { llm: LlmLike; calls: string[] } {
  const calls: string[] = []
  const models: ModelInfoLike[] = [{ id: 'glm-5', contextWindow: 200_000 }]
  const llm: LlmLike = {
    listProviders: () => [{ id: 'zcode-cli', name: 'ZCode CLI' }],
    listConfigurableProviders: () => [],
    listModels: async (provider: string) => {
      calls.push(provider)
      return models
    },
  }
  return { llm, calls }
}

/** Build the adapter context. */
function contextFor(
  profileDir: string,
  llm: LlmLike,
  connectionCheck: boolean,
): AdapterContext {
  return {
    host: { llm },
    dshHome: profileDir,
    profileDir,
    signal: new AbortController().signal,
    budgetMs: 15_000,
    connectionCheck,
  }
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ZCode diagnose, offline run', () => {
  it('starts no process at all', async () => {
    const { profileDir, marker } = fakeProfile()
    const { llm } = recordingLlm()
    await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    expect(existsSync(marker)).toBe(false)
  })

  it('never asks the host for a catalog that would spawn the resident client', async () => {
    const { profileDir } = fakeProfile()
    const { llm, calls } = recordingLlm()
    await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    expect(calls).toEqual([])
  })

  it('says why the catalog was not read, instead of implying the catalog is broken', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    const catalog = checks.find((check) => check.id === 'model-catalog')
    expect(catalog?.status).toBe('not_checked')
    expect(catalog?.reasonCode).toBe('not_requested')
    expect(catalog?.details).toMatchObject({ startsProcess: true })
    expect(catalog?.summary).toContain('would start its own client')
  })

  it('reports the credential and diagnostic as not requested rather than passing them', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    const credential = checks.find((check) => check.id === 'credential-metadata')
    const diagnostic = checks.find((check) => check.id === 'provider-diagnostic')
    expect(credential?.status).toBe('not_checked')
    expect(credential?.reasonCode).toBe('not_requested')
    expect(diagnostic?.status).toBe('not_checked')
    expect(diagnostic?.reasonCode).toBe('not_requested')
  })

  it('still reads everything the profile can answer without a process', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    const installed = checks.find((check) => check.id === 'plugin-installed')
    const registered = checks.find((check) => check.id === 'provider-registered')
    expect(installed?.status).toBe('pass')
    expect(registered?.status).toBe('pass')
  })

  it('returns every promised check exactly once', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, false))
    expect(checks.map((check) => check.id).sort()).toEqual([...ZCODE_ADAPTER.checks].sort())
  })
})

describe('ZCode diagnose, requested connection check', () => {
  it('runs the plugin diagnostic', async () => {
    const { profileDir, marker } = fakeProfile()
    const { llm } = recordingLlm()
    await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, true))
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('reads the catalog, because the user already accepted a process', async () => {
    const { profileDir } = fakeProfile()
    const { llm, calls } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, true))
    expect(calls).toEqual(['zcode-cli'])
    expect(checks.find((check) => check.id === 'model-catalog')?.status).toBe('pass')
  })

  it('reports the credential the CLI read, not the token', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, true))
    const credential = checks.find((check) => check.id === 'credential-metadata')
    expect(credential?.status).toBe('pass')
    expect(JSON.stringify(credential)).not.toContain('planToken')
  })

  it('keeps the CLI path out of the diagnostic details', async () => {
    const { profileDir } = fakeProfile()
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, true))
    const diagnostic = checks.find((check) => check.id === 'provider-diagnostic')
    expect(diagnostic?.status).toBe('pass')
    expect(JSON.stringify(diagnostic)).not.toContain('fake\\zcode.cjs')
    expect(diagnostic?.details).toMatchObject({ cliLocated: true, reportedModels: 2 })
  })

  it('turns a hung CLI into timeouts rather than a verdict', async () => {
    const { profileDir } = fakeProfile()
    const packageDir = join(profileDir, 'node_modules', PACKAGE)
    writeFileSync(join(packageDir, 'bin.js'), 'setTimeout(() => {}, 60_000)\n')
    const { llm } = recordingLlm()
    const context = { ...contextFor(profileDir, llm, true), budgetMs: 400 }
    const checks = await ZCODE_ADAPTER.diagnose(context)
    const diagnostic = checks.find((check) => check.id === 'provider-diagnostic')
    expect(diagnostic?.status).toBe('timeout')
    expect(diagnostic?.reasonCode).toBe('timed_out')
  })

  it('reports a signed-out account when the CLI says it has no token', async () => {
    const { profileDir, marker } = fakeProfile()
    const packageDir = join(profileDir, 'node_modules', PACKAGE)
    const signedOut = {
      command: 'doctor',
      ok: false,
      facts: { credentials: { error: 'ENOENT' } },
    }
    writeFileSync(
      join(packageDir, 'bin.js'),
      [
        "const { appendFileSync } = require('node:fs')",
        'appendFileSync(' + JSON.stringify(marker) + ", 'launched\\n')",
        'process.stdout.write(' + JSON.stringify(JSON.stringify(signedOut)) + ')',
        '',
      ].join('\n'),
    )
    const { llm } = recordingLlm()
    const checks = await ZCODE_ADAPTER.diagnose(contextFor(profileDir, llm, true))
    const credential = checks.find((check) => check.id === 'credential-metadata')
    expect(credential?.status).toBe('fail')
    expect(credential?.reasonCode).toBe('credential_missing')
  })
})
