/**
 * The child-process wrapper for the ZCode bridge's own diagnostic CLI.
 *
 * `dsh-zcode-plan-bridge` ships `bin/dsh-zcode-plan-bridge.js`, which exposes
 * five subcommands. Their cost is not uniform, and that difference is the whole
 * reason this module exists:
 *
 * | command    | network | process                 | quota |
 * |------------|---------|-------------------------|-------|
 * | `doctor`   | no      | may start an app-server | none  |
 * | `models`   | no      | may start an app-server | none  |
 * | `protocol` | maybe   | starts an app-server    | none  |
 * | `turn`     | yes     | starts an app-server    | **spent** |
 * | `image`    | yes     | starts an app-server    | **spent** |
 *
 * `turn` and `image` send a real turn to the user's Start Plan account. A
 * diagnostic tool must never spend a person's quota as a side effect of being
 * looked at, so they are refused structurally by {@link PROHIBITED_COMMANDS}
 * inside {@link runPluginCli} rather than by convention at each call site. A
 * future contributor who adds a call to `turn` gets a thrown error, not a bill.
 *
 * Everything here is read-only with respect to the provider: no file is
 * written, no directory is scanned for anything but the plugin's own manifest.
 *
 * @module dsh-provider-doctor/providers/zcode/cli
 */

import { execFile, type ChildProcess } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { describeError } from '../shared/check-helpers.ts'

/**
 * Subcommands that spend Start Plan quota.
 *
 * This is a hard gate, not documentation: {@link runPluginCli} throws when it
 * is asked to run one of these. The doctor never needs them — `doctor` already
 * proves every local precondition, and `protocol` proves the app-server
 * handshake without sending a turn.
 */
export const PROHIBITED_COMMANDS: ReadonlySet<string> = new Set(['turn', 'image'])

/** stdout+stderr ceiling for one CLI run. Generous: `doctor --json` prints a catalogue. */
export const CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** The options a child process is started with. Closed on purpose: no env overrides. */
export interface ExecCallOptions {
  /** Never true: argument arrays must not pass through a shell. */
  shell: false
  /** Keep a console window from flashing on Windows. */
  windowsHide: true
  /** Wall-clock budget enforced by `execFile` itself. */
  timeout: number
  /** Output ceiling. */
  maxBuffer: number
  /** Cancellation; Node kills the direct child when this aborts. */
  signal: AbortSignal
  /** Decode both streams so callers never handle buffers. */
  encoding: 'utf8'
  /** Working directory; omitted means the host's own. */
  cwd?: string
}

/** How one `execFile` call settled, with the failure already classified. */
export interface ExecFileFailure {
  /**
   * `missing` — the executable or its file could not be started (`ENOENT`,
   * `EACCES`, `ENOTDIR`); `killed` — the process was signalled (timeout or
   * abort); `failed` — it started and exited non-zero.
   */
  kind: 'missing' | 'killed' | 'failed'
  /** The raw `code` from the error, which is a string for spawn errors. */
  code: string | number | undefined
  /** Whatever the process managed to print before it failed. */
  stdout: string
  stderr: string
  /** The original error, kept for message extraction only. */
  error: unknown
}

/** The outcome of one `execFile` call. */
export type ExecFileOutcome =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; failure: ExecFileFailure }

/**
 * The `execFile` shape this module runs through.
 *
 * Injectable so tests can drive every branch without starting a process: the
 * whole point of the wrapper is to be boring and testable, and a fake that
 * returns a hand-built {@link ExecFileOutcome} exercises the classification
 * logic more precisely than a real CLI ever could.
 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecCallOptions,
) => Promise<ExecFileOutcome>

/** How one CLI invocation settled. */
export type PluginCliOutcome =
  /** It ran and exited zero; `stdout` is whatever it printed. */
  | { kind: 'output'; code: 0; stdout: string; stderr: string }
  /** It could not be started: the CLI or its entry file is not there. */
  | { kind: 'missing' }
  /**
   * It was signalled. The wrapper deliberately does not decide whether that was
   * a timeout or a cancellation — only the caller knows whether the outer
   * `AbortSignal` was aborted, and guessing here is how a cancelled run turns
   * into a false "signed out".
   */
  | { kind: 'killed'; aborted: boolean }
  /** It ran and exited non-zero. Output is kept: a doctor may fail *and* print JSON. */
  | { kind: 'failed'; code: number | undefined; message: string; stdout: string; stderr: string }

/**
 * Start a child process and classify how it settled.
 *
 * `process.execPath` is used as the interpreter on purpose: the CLI is
 * JavaScript, `node` is not guaranteed to be on `PATH` in a desktop host, and
 * the host's own runtime is the one known to satisfy the CLI's engine range.
 *
 * ## Windows process-tree limitation (known, documented)
 *
 * `execFile` kills only the process it started. On Windows that is a
 * `TerminateProcess` against the direct child; grandchildren are not touched,
 * and there is no job object in sight. This matters here because `doctor` may
 * start a throwaway `zcode app-server` grandchild to read the catalogue: if the
 * timeout fires mid-`doctor`, that grandchild can outlive this wrapper.
 *
 * The only in-process mitigation is what is done below — on abort the direct
 * child is escalated to `SIGKILL` ourselves instead of waiting for the default
 * `SIGTERM`. `taskkill /T` would reap the tree, but it is an external command,
 * needs a shell, is Windows-only, and races with PID reuse, so it is
 * deliberately not used. The practical consequence: a killed `doctor` run may
 * leave one short-lived app-server behind. The default diagnosis path never
 * runs `protocol` (whose entire purpose is a long-lived app-server) and keeps a
 * budget generous enough that this stays rare.
 *
 * @param options - Which CLI, which arguments, and how long it may take.
 * @returns How the invocation settled, in the closed vocabulary above.
 * @throws When `args[0]` is a quota-spending subcommand.
 */
export async function runPluginCli(options: RunPluginCliOptions): Promise<PluginCliOutcome> {
  const command = options.args[0]
  if (command !== undefined && PROHIBITED_COMMANDS.has(command)) {
    throw new Error(
      `refusing to run the "${command}" subcommand: it spends Start Plan quota and the doctor never does that`,
    )
  }
  // An already-cancelled run must not start a process at all.
  if (options.signal.aborted) return { kind: 'killed', aborted: true }

  const run = options.execFile ?? defaultExecFile
  const execOptions: ExecCallOptions = {
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: CLI_MAX_BUFFER_BYTES,
    signal: options.signal,
    encoding: 'utf8',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }

  const outcome = await run(process.execPath, [options.cliPath, ...options.args], execOptions)
  if (outcome.ok) return { kind: 'output', code: 0, stdout: outcome.stdout, stderr: outcome.stderr }

  const failure = outcome.failure
  if (failure.kind === 'missing') return { kind: 'missing' }
  if (failure.kind === 'killed') {
    return { kind: 'killed', aborted: options.signal.aborted || isAbortError(failure.error) }
  }
  return {
    kind: 'failed',
    code: typeof failure.code === 'number' ? failure.code : undefined,
    message: describeError(failure.error),
    stdout: failure.stdout,
    stderr: failure.stderr,
  }
}

/** The arguments one CLI invocation needs. */
export interface RunPluginCliOptions {
  /** Absolute path to `bin/dsh-zcode-plan-bridge.js` inside the profile. */
  cliPath: string
  /** Subcommand first, flags after. Never `turn` or `image`. */
  args: readonly string[]
  /** Cancellation for the whole diagnosis. */
  signal: AbortSignal
  /** Wall-clock budget for the child process. */
  timeoutMs: number
  /** Replaceable process starter; defaults to {@link defaultExecFile}. */
  execFile?: ExecFileLike
  /** Working directory for the child; omitted means the host's own. */
  cwd?: string
}

/** Was this error an `AbortSignal` cancellation rather than a timeout kill? */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { name?: unknown; code?: unknown }
  return record.name === 'AbortError' || record.code === 'ABORT_ERR'
}

/**
 * The real `execFile` call, promisified and classified.
 *
 * Two details are worth keeping:
 *
 * - a non-zero exit is *not* treated as "no output": the ZCode doctor prints
 *   its machine-readable summary and then exits 1 when a precondition failed,
 *   so stdout has to survive the failure;
 * - an abort listener escalates the direct child to `SIGKILL` immediately,
 *   because `execFile`'s own kill uses `SIGTERM` and a stuck native CLI can
 *   ignore it.
 */
const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise<ExecFileOutcome>((resolveOutcome) => {
    let settled = false
    let child: ChildProcess | undefined
    let reap = (): void => {}

    const finish = (outcome: ExecFileOutcome): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', onAbort)
      reap()
      resolveOutcome(outcome)
    }

    const onAbort = (): void => {
      if (child === undefined) return
      try {
        child.kill('SIGKILL')
      } catch {
        // Best effort: the process may already be gone.
      }
    }

    try {
      child = execFile(file, [...args], options, (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (error === null || error === undefined) {
          finish({ ok: true, stdout: out, stderr: err })
          return
        }
        const rawCode = (error as { code?: unknown }).code
        const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
          finish({ ok: false, failure: { kind: 'missing', code, stdout: out, stderr: err, error } })
          return
        }
        // `killed` is set both for our timeout and for an abort; the name/code
        // check catches the abort shapes Node does not mark with `killed`.
        if ((error as { killed?: unknown }).killed === true || isAbortError(error)) {
          finish({ ok: false, failure: { kind: 'killed', code, stdout: out, stderr: err, error } })
          return
        }
        finish({ ok: false, failure: { kind: 'failed', code, stdout: out, stderr: err, error } })
      })
    } catch (error) {
      finish({ ok: false, failure: { kind: 'failed', code: undefined, stdout: '', stderr: '', error } })
      return
    }

    reap = (): void => {
      if (child === undefined) return
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGKILL')
      } catch {
        // Best effort: the process may already be gone.
      }
    }

    options.signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Locate the plugin's CLI entry point inside a profile, without running it.
 *
 * Resolution is deliberately manual (`<profile>/node_modules/<pkg>/package.json`)
 * rather than `import.meta.resolve`: the doctor runs from the *host's* module
 * graph, which is not necessarily the profile's, and a resolved URL would name
 * the doctor's own copy of the package rather than the one the profile loaded.
 * Reading the profile's manifest and its declared `bin` reports what the user's
 * installation actually ships.
 *
 * @param profileDir - The profile directory, or `undefined` when it is unknown.
 * @param pluginName - The npm package name, scoped or not.
 * @returns The absolute path to the CLI entry, or `undefined` when it is absent.
 */
export async function resolvePluginCli(
  profileDir: string | undefined,
  pluginName: string,
): Promise<string | undefined> {
  if (profileDir === undefined || profileDir === '' || pluginName === '') return undefined
  const packageDir = join(profileDir, 'node_modules', pluginName)
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined

  const bin = (manifest as { bin?: unknown }).bin
  const entry = firstBinPath(bin, pluginName)
  if (entry === undefined) return undefined

  const absolute = isAbsolute(entry) ? entry : resolve(packageDir, entry)
  try {
    await access(absolute)
  } catch {
    return undefined
  }
  return absolute
}

/** Pick one file out of a manifest `bin` field (string or name→path map). */
function firstBinPath(bin: unknown, pluginName: string): string | undefined {
  if (typeof bin === 'string' && bin !== '') return bin
  if (typeof bin !== 'object' || bin === null) return undefined
  const entries = Object.entries(bin as Record<string, unknown>)
  // Prefer the key that matches the package's own name: a package may expose
  // several executables, and only one of them is its diagnostic entry point.
  const unscoped = pluginName.includes('/') ? pluginName.split('/').at(-1) : pluginName
  const preferred = entries.find(([key]) => key === unscoped || key === pluginName)
  const chosen = preferred ?? entries[0]
  if (chosen === undefined) return undefined
  const value = chosen[1]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the first balanced JSON object out of a stream that also contains prose.
 *
 * The ZCode CLI writes a human-readable narrative and then the JSON summary, so
 * neither `JSON.parse(stdout)` nor "take the last line" is right. This scans
 * for `{`, walks to the matching `}` while ignoring braces inside strings, and
 * parses that slice. If a candidate slice is malformed, the scan continues from
 * the next `{`, so one stray brace in a warning line cannot poison the parse.
 *
 * @param stdout - Everything the CLI printed on stdout.
 * @returns The parsed value, or `undefined` when no balanced object parsed.
 */
export function parseJsonFromOutput(stdout: string): unknown | undefined {
  for (let start = stdout.indexOf('{'); start !== -1; start = stdout.indexOf('{', start + 1)) {
    const end = findClosingBrace(stdout, start)
    if (end === -1) continue
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as unknown
    } catch {
      // Not valid JSON: keep scanning, a later object may be the summary.
    }
  }
  return undefined
}

/**
 * Index of the `}` that closes the object opened at `start`, or `-1`.
 *
 * String literals and escape sequences are tracked so that a brace inside a
 * quoted diagnostic message does not move the depth counter.
 */
function findClosingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) return -1
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}
