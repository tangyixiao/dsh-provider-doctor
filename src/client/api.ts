/**
 * The browser half's only way to reach the Host half.
 *
 * Every route is same-origin: the browser half calls `/plugins/dsh-provider-doctor/...`
 * with a relative URL, so the owner cookie the DSH client already holds is sent
 * automatically and nothing has to be stored, refreshed or read out of the
 * renderer.
 *
 * The three failure modes are kept apart because they call for different
 * actions: `unauthorized` means this session is not the host owner,
 * `unreachable` means the host did not answer at all, and `bad-payload` means it
 * answered with something this build cannot read.
 *
 * @module dsh-provider-doctor/client/api
 */

import type { ShareableReport } from '../shared/contract.ts'
import { isReasonCode } from '../shared/reason-codes.ts'
import type { DoctorSnapshot, StatusResponse } from '../shared/snapshot.ts'
import {
  CANCEL_PATH,
  CONNECT_PATH,
  DIAGNOSE_PATH,
  SHARE_PATH,
  STATUS_PATH,
} from '../shared/status-paths.ts'

/** Why a request did not produce data. */
export type ApiFailure =
  /** The session is not the host owner (HTTP 401/403). */
  | { kind: 'unauthorized' }
  /** The host did not answer, or the answer was not HTTP. */
  | { kind: 'unreachable'; detail: string }
  /** The host answered with an unreadable body. */
  | { kind: 'bad-payload'; detail: string }
  /** The host answered with an error status and a readable envelope. */
  | { kind: 'http'; status: number; code?: string }

/** A request's outcome. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure }

/** The envelope every doctor route uses on failure. */
interface ErrorEnvelope {
  error?: string
}

/**
 * Read a JSON body without trusting its shape.
 *
 * @param response - The fetch response.
 * @returns The parsed value, or `undefined` when the body is not JSON.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Turn a non-OK response into the failure the UI explains.
 *
 * @param response - The fetch response, already known to be non-OK.
 * @returns The classified failure.
 */
async function failureOf(response: Response): Promise<ApiFailure> {
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' }
  const body = await readJson(response)
  const code =
    body !== null && typeof body === 'object' && typeof (body as ErrorEnvelope).error === 'string'
      ? (body as ErrorEnvelope).error
      : undefined
  return code === undefined
    ? { kind: 'http', status: response.status }
    : { kind: 'http', status: response.status, code }
}

/**
 * Issue one same-origin request and classify the outcome.
 *
 * @param path - The route, relative to the app origin.
 * @param init - Fetch options.
 * @returns The parsed body or a classified failure.
 */
async function request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
    })
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'unreachable', detail: error instanceof Error ? error.message : 'fetch failed' },
    }
  }
  if (!response.ok) return { ok: false, failure: await failureOf(response) }
  const body = await readJson(response)
  if (body === undefined) {
    return { ok: false, failure: { kind: 'bad-payload', detail: 'body is not JSON' } }
  }
  return { ok: true, value: body as T }
}

/**
 * Read the Host's cached snapshot. Never runs a check.
 *
 * @param signal - Cancellation for the request itself.
 * @returns The status envelope, or a classified failure.
 */
export function fetchStatus(signal?: AbortSignal): Promise<ApiResult<StatusResponse>> {
  return request<StatusResponse>(STATUS_PATH, {
    method: 'GET',
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Run the offline checks.
 *
 * @param signal - Cancellation for the request itself.
 * @returns The fresh snapshot, or a classified failure.
 */
export function runBasic(signal?: AbortSignal): Promise<ApiResult<{ empty: false } & DoctorSnapshot>> {
  return request<{ empty: false } & DoctorSnapshot>(DIAGNOSE_PATH, {
    method: 'POST',
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Run the offline checks plus the side-effecting connection check.
 *
 * Only reached from a control that discloses what will start running.
 *
 * @param signal - Cancellation for the request itself.
 * @returns The fresh snapshot, or a classified failure.
 */
export function runConnection(signal?: AbortSignal): Promise<ApiResult<{ empty: false } & DoctorSnapshot>> {
  return request<{ empty: false } & DoctorSnapshot>(CONNECT_PATH, {
    method: 'POST',
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Ask the Host to abort the run in flight.
 *
 * @returns The acknowledgement, or a classified failure.
 */
export function cancelRun(): Promise<ApiResult<{ cancelled: boolean }>> {
  return request<{ cancelled: boolean }>(CANCEL_PATH, { method: 'POST' })
}

/**
 * Fetch the redacted document for the last run.
 *
 * @returns The shareable document, or a classified failure.
 */
export function fetchShareable(): Promise<ApiResult<ShareableReport>> {
  return request<ShareableReport>(SHARE_PATH, { method: 'GET' })
}

/**
 * Render the redacted document as the text the copy control puts on the
 * clipboard.
 *
 * The browser half formats it itself rather than asking the Host, so the
 * clipboard content is built from the same whitelist-only document the user
 * just reviewed, with no second formatting path to keep in sync.
 *
 * @param report - The shareable document.
 * @returns Pasteable text.
 */
export function formatShareable(report: ShareableReport): string {
  const lines: string[] = [
    `dsh-provider-doctor ${report.version} — ${report.platform}/${report.architecture}, ${report.runtime}`,
    '',
  ]
  for (const entry of report.reports) {
    const { readiness } = entry
    lines.push(entry.provider)
    lines.push(
      `  installed=${readiness.installed} enabled=${readiness.enabled} registration=${readiness.registration} catalog=${readiness.catalog} liveInference=${readiness.liveInference}`,
    )
    for (const check of entry.checks) {
      // Only codes the contract defines are printed: an unrecognised string here
      // would be a value the Host did not vet, and this text leaves the machine.
      const code =
        check.reasonCode !== undefined && isReasonCode(check.reasonCode) ? ` (${check.reasonCode})` : ''
      lines.push(`  - ${check.id}: ${check.status}/${check.evidenceKind} via ${check.source}${code}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Copy text to the clipboard, with the fallbacks an Electron renderer needs.
 *
 * The host renderer may run without `navigator.clipboard` (insecure origin,
 * disabled permission), so the deprecated selection path is kept as a real
 * fallback rather than a courtesy.
 *
 * @param text - What to copy.
 * @returns Whether the copy is believed to have happened.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the selection path.
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
