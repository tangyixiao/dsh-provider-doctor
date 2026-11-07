import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CLI_MAX_BUFFER_BYTES,
  PROHIBITED_COMMANDS,
  parseJsonFromOutput,
  resolvePluginCli,
  runPluginCli,
  type ExecCallOptions,
  type ExecFileLike,
} from '../../src/providers/process.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pd-process-'))
  scratch.push(dir)
  return dir
}

/** A profile whose `node_modules/<pkg>` carries a manifest and a bin file. */
function profileWith(packageName: string, manifest: unknown, binFiles: readonly string[] = []): string {
  const profileDir = scratchDir()
  const packageDir = join(profileDir, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  for (const file of binFiles) {
    mkdirSync(join(packageDir, file, '..'), { recursive: true })
    writeFileSync(join(packageDir, file), '#!/usr/bin/env node\n')
  }
  return profileDir
}

function controller(): AbortController {
  return new AbortController()
}

/** A process starter that records its call and returns a canned outcome. */
function fakeExec(
  outcome: Awaited<ReturnType<ExecFileLike>>,
): ExecFileLike & { calls: { file: string; args: readonly string[]; options: ExecCallOptions }[] } {
  const calls: { file: string; args: readonly string[]; options: ExecCallOptions }[] = []
  const exec = (async (file, args, options) => {
    calls.push({ file, args, options })
    return outcome
  }) as ExecFileLike & { calls: typeof calls }
  exec.calls = calls
  return exec
}

describe('PROHIBITED_COMMANDS', () => {
  it('covers exactly the two quota-spending subcommands', () => {
    expect([...PROHIBITED_COMMANDS]).toEqual(['turn', 'image'])
  })
})

describe('runPluginCli', () => {
  it('refuses to run turn before touching the process starter', async () => {
    const exec = fakeExec({ ok: true, stdout: '', stderr: '' })
    await expect(
      runPluginCli({ cliPath: '/nowhere/cli.js', args: ['turn', 'hello'], signal: controller().signal, timeoutMs: 1000, execFile: exec }),
    ).rejects.toThrow(/refusing to run the "turn" subcommand/)
    expect(exec.calls).toHaveLength(0)
  })

  it('refuses to run image too', async () => {
    const exec = fakeExec({ ok: true, stdout: '', stderr: '' })
    await expect(
      runPluginCli({ cliPath: '/nowhere/cli.js', args: ['image', 'x.png'], signal: controller().signal, timeoutMs: 1000, execFile: exec }),
    ).rejects.toThrow(/refusing to run the "image" subcommand/)
    expect(exec.calls).toHaveLength(0)
  })

  it('refuses even when the caller already aborted, because the rule is not conditional', async () => {
    const aborted = controller()
    aborted.abort()
    const exec = fakeExec({ ok: true, stdout: '', stderr: '' })
    await expect(
      runPluginCli({ cliPath: '/nowhere/cli.js', args: ['turn'], signal: aborted.signal, timeoutMs: 1000, execFile: exec }),
    ).rejects.toThrow(/refusing to run/)
  })

  it('does not start a process for an already-cancelled run', async () => {
    const aborted = controller()
    aborted.abort()
    const exec = fakeExec({ ok: true, stdout: 'never', stderr: '' })
    const outcome = await runPluginCli({
      cliPath: '/nowhere/cli.js',
      args: ['doctor', '--json'],
      signal: aborted.signal,
      timeoutMs: 1000,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'killed', aborted: true })
    expect(exec.calls).toHaveLength(0)
  })

  it('runs the CLI through the host node binary with a closed option set', async () => {
    const exec = fakeExec({ ok: true, stdout: 'ready', stderr: '' })
    await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor', '--json'],
      signal: controller().signal,
      timeoutMs: 1234,
      execFile: exec,
    })
    expect(exec.calls).toHaveLength(1)
    const call = exec.calls[0]
    expect(call?.file).toBe(process.execPath)
    expect(call?.args).toEqual(['/profile/cli.js', 'doctor', '--json'])
    expect(call?.options).toMatchObject({
      shell: false,
      windowsHide: true,
      timeout: 1234,
      maxBuffer: CLI_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    })
    expect(call?.options).not.toHaveProperty('cwd')
  })

  it('passes an explicit working directory through', async () => {
    const exec = fakeExec({ ok: true, stdout: '', stderr: '' })
    await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
      cwd: '/profile',
    })
    expect(exec.calls[0]?.options.cwd).toBe('/profile')
  })

  it('reports zero-exit output verbatim', async () => {
    const exec = fakeExec({ ok: true, stdout: '{"ok":true}', stderr: 'noise' })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'output', code: 0, stdout: '{"ok":true}', stderr: 'noise' })
  })

  it('maps a spawn failure to missing', async () => {
    const exec = fakeExec({
      ok: false,
      failure: { kind: 'missing', code: 'ENOENT', stdout: '', stderr: '', error: new Error('ENOENT') },
    })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'missing' })
  })

  it('reports killed as a timeout when the caller was never aborted', async () => {
    const exec = fakeExec({
      ok: false,
      failure: { kind: 'killed', code: 'ETIMEDOUT', stdout: '', stderr: '', error: new Error('timed out') },
    })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'killed', aborted: false })
  })

  it('reports killed as a cancellation when the caller aborted', async () => {
    const outer = controller()
    const exec = (async (_file: string, _args: readonly string[], options: ExecCallOptions) => {
      outer.abort()
      return {
        ok: false as const,
        failure: {
          kind: 'killed' as const,
          code: 'ABORT_ERR',
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        },
      }
    }) as ExecFileLike
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: outer.signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'killed', aborted: true })
  })

  it('treats an AbortError shape as a cancellation even when the signal is clean', async () => {
    const exec = fakeExec({
      ok: false,
      failure: {
        kind: 'killed',
        code: 'ABORT_ERR',
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }),
      },
    })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toEqual({ kind: 'killed', aborted: true })
  })

  it('keeps stdout from a non-zero exit, because a doctor may print JSON and then fail', async () => {
    const exec = fakeExec({
      ok: false,
      failure: {
        kind: 'failed',
        code: 1,
        stdout: '{"command":"doctor","ok":false,"facts":{}}',
        stderr: 'precondition failed',
        error: new Error('Command failed: exit 1'),
      },
    })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toMatchObject({
      kind: 'failed',
      code: 1,
      stdout: '{"command":"doctor","ok":false,"facts":{}}',
      stderr: 'precondition failed',
    })
  })

  it('drops a non-numeric exit code rather than passing a spawn code through', async () => {
    const exec = fakeExec({
      ok: false,
      failure: { kind: 'failed', code: 'E2BIG', stdout: '', stderr: '', error: new Error('too big') },
    })
    const outcome = await runPluginCli({
      cliPath: '/profile/cli.js',
      args: ['doctor'],
      signal: controller().signal,
      timeoutMs: 10,
      execFile: exec,
    })
    expect(outcome).toMatchObject({ kind: 'failed', code: undefined })
  })
})

describe('resolvePluginCli', () => {
  it('returns undefined without a profile directory', async () => {
    expect(await resolvePluginCli(undefined, 'pkg')).toBeUndefined()
  })

  it('returns undefined for an empty profile directory', async () => {
    expect(await resolvePluginCli('', 'pkg')).toBeUndefined()
  })

  it('returns undefined when the package is not installed', async () => {
    expect(await resolvePluginCli(scratchDir(), 'pkg')).toBeUndefined()
  })

  it('returns undefined when the manifest is not JSON', async () => {
    const profileDir = scratchDir()
    const packageDir = join(profileDir, 'node_modules', 'pkg')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), '{ nope')
    expect(await resolvePluginCli(profileDir, 'pkg')).toBeUndefined()
  })

  it('resolves a string bin relative to the package directory', async () => {
    const profileDir = profileWith('pkg', { bin: 'lib/bin.js' }, ['lib/bin.js'])
    const resolved = await resolvePluginCli(profileDir, 'pkg')
    expect(resolved).toBe(join(profileDir, 'node_modules', 'pkg', 'lib', 'bin.js'))
  })

  it('keeps an absolute bin as written', async () => {
    const absolute = join(scratchDir(), 'entry.js')
    writeFileSync(absolute, '#!/usr/bin/env node\n')
    const profileDir = profileWith('pkg', { bin: absolute })
    expect(await resolvePluginCli(profileDir, 'pkg')).toBe(absolute)
  })

  it('prefers the bin key that matches the package name', async () => {
    const profileDir = profileWith(
      'pkg',
      { bin: { 'other-tool': 'lib/other.js', pkg: 'lib/diagnose.js' } },
      ['lib/other.js', 'lib/diagnose.js'],
    )
    expect(await resolvePluginCli(profileDir, 'pkg')).toBe(
      join(profileDir, 'node_modules', 'pkg', 'lib', 'diagnose.js'),
    )
  })

  it('matches a scoped package name on its unscoped tail', async () => {
    const profileDir = profileWith(
      '@scope/pkg',
      { bin: { first: 'lib/first.js', pkg: 'lib/diagnose.js' } },
      ['lib/first.js', 'lib/diagnose.js'],
    )
    expect(await resolvePluginCli(profileDir, '@scope/pkg')).toBe(
      join(profileDir, 'node_modules', '@scope', 'pkg', 'lib', 'diagnose.js'),
    )
  })

  it('falls back to the first bin when none matches', async () => {
    const profileDir = profileWith('pkg', { bin: { alpha: 'lib/a.js', beta: 'lib/b.js' } }, ['lib/a.js', 'lib/b.js'])
    expect(await resolvePluginCli(profileDir, 'pkg')).toBe(join(profileDir, 'node_modules', 'pkg', 'lib', 'a.js'))
  })

  it('returns undefined when the declared entry file is absent', async () => {
    const profileDir = profileWith('pkg', { bin: 'lib/missing.js' })
    expect(await resolvePluginCli(profileDir, 'pkg')).toBeUndefined()
  })

  it('returns undefined for a manifest without bin', async () => {
    const profileDir = profileWith('pkg', { name: 'pkg', version: '1.0.0' })
    expect(await resolvePluginCli(profileDir, 'pkg')).toBeUndefined()
  })

  it('returns undefined for an empty bin map', async () => {
    const profileDir = profileWith('pkg', { bin: {} })
    expect(await resolvePluginCli(profileDir, 'pkg')).toBeUndefined()
  })

  it('returns undefined for an empty bin string', async () => {
    const profileDir = profileWith('pkg', { bin: '' })
    expect(await resolvePluginCli(profileDir, 'pkg')).toBeUndefined()
  })
})

describe('parseJsonFromOutput', () => {
  it('finds a bare document', () => {
    expect(parseJsonFromOutput('{"a":1}')).toEqual({ a: 1 })
  })

  it('finds a document after narrative output', () => {
    expect(parseJsonFromOutput('checking...\nall good\n{"ok":true,"n":2}\n')).toEqual({ ok: true, n: 2 })
  })

  it('keeps braces that live inside strings', () => {
    const text = '{"message":"use {curly} braces","ok":true}'
    expect(parseJsonFromOutput(text)).toEqual({ message: 'use {curly} braces', ok: true })
  })

  it('keeps escaped quotes from closing the string early', () => {
    const text = '{"message":"he said \\"hi\\" loudly","ok":true}'
    expect(parseJsonFromOutput(text)).toEqual({ message: 'he said "hi" loudly', ok: true })
  })

  it('skips a malformed object and parses the next one', () => {
    expect(parseJsonFromOutput('{oops} then {"ok":true}')).toEqual({ ok: true })
  })

  it('returns undefined for prose without JSON', () => {
    expect(parseJsonFromOutput('nothing to see here')).toBeUndefined()
  })

  it('returns undefined for an unterminated object', () => {
    expect(parseJsonFromOutput('{"ok":true')).toBeUndefined()
  })

  it('returns undefined for an empty stream', () => {
    expect(parseJsonFromOutput('')).toBeUndefined()
  })

  it('parses a document nested after a stray unmatched brace', () => {
    expect(parseJsonFromOutput('warning { stray\n{"ok":true}')).toEqual({ ok: true })
  })
})
