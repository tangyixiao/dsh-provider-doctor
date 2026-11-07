/**
 * Minimal fakes for the two Node HTTP objects the routes touch.
 *
 * The doctor's routes are plain request handlers, so a full `http.Server` is
 * unnecessary: what matters is the status, headers and JSON body they write.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** What a handler wrote, in the shape the test asserts on. */
export interface RecordedResponse {
  status: number
  headers: Record<string, string>
  body: unknown
  /** The raw body, for routes that do not answer in JSON. */
  raw: string
  ended: boolean
}

/** Build the request side of one call. */
export function makeRequest(init: {
  method: string
  url?: string
  headers?: Record<string, string | undefined>
}): IncomingMessage {
  return {
    method: init.method,
    url: init.url ?? '/',
    headers: init.headers ?? {},
  } as unknown as IncomingMessage
}

/** Build a response that records what it was given. */
export function makeResponse(): { res: ServerResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: 0, headers: {}, body: undefined, raw: '', ended: false }
  const res = {
    headersSent: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      recorded.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
      return this
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      recorded.status = status
      for (const [name, value] of Object.entries(headers ?? {})) {
        recorded.headers[name.toLowerCase()] = String(value)
      }
      ;(res as unknown as { headersSent: boolean }).headersSent = true
      return res
    },
    end(payload?: string) {
      recorded.ended = true
      recorded.raw = payload ?? ''
      if (recorded.raw !== '') {
        try {
          recorded.body = JSON.parse(recorded.raw)
        } catch {
          recorded.body = undefined
        }
      }
      return res
    },
  } as unknown as ServerResponse
  return { res, recorded }
}
