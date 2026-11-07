/**
 * Loopback checks for the doctor's own routes.
 *
 * A local HTTP route is reachable by anything that can open a socket, including
 * a page in the user's browser. The defence is to require that both the `Host`
 * header and (when present) the `Origin` header name a loopback authority, so a
 * cross-site page cannot drive the doctor even if it guesses the port.
 *
 * This is the same policy the WorkBuddy plugin applies to its status routes;
 * the doctor re-implements the two predicates rather than importing that
 * package, because the doctor must stay installable on its own.
 *
 * @module dsh-provider-doctor/host/loopback
 */

/** Hostnames that mean "this machine", in the spellings Node and browsers use. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Extract a hostname from a `Host` header value.
 *
 * Handles `host`, `host:port`, IPv4, bracketed IPv6, and the bare `::1` form.
 * Anything unparseable returns `undefined`, which every caller treats as "not
 * loopback".
 *
 * @param host - A `Host` header value.
 * @returns The lowercase hostname, or `undefined`.
 */
export function hostnameOfHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined
  const trimmed = host.trim()
  if (trimmed === '') return undefined

  // Bracketed IPv6, optionally with a port: `[::1]`, `[::1]:13639`.
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']')
    if (closing === -1) return undefined
    return trimmed.slice(0, closing + 1).toLowerCase()
  }

  // Bare IPv6 without brackets (`::1`): only the all-colon form is plausible,
  // and it cannot carry a port, so it never gets split.
  if (trimmed.includes(':') && trimmed.split(':').length > 2) return trimmed.toLowerCase()

  const colon = trimmed.lastIndexOf(':')
  if (colon === -1) return trimmed.toLowerCase()
  const port = trimmed.slice(colon + 1)
  if (!/^\d+$/.test(port)) return undefined
  return trimmed.slice(0, colon).toLowerCase()
}

/**
 * Does this `Host` header name the local machine?
 *
 * @param host - A `Host` header value.
 * @returns True when the authority is loopback.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  const hostname = hostnameOfHost(host)
  return hostname !== undefined && LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * Is this `Origin` header acceptable for a local request?
 *
 * A missing `Origin` is accepted: same-origin `GET`s from a browser and
 * non-browser callers (a CLI health probe) send none, and the principal check
 * still applies. A present `Origin` must parse and name loopback.
 *
 * @param origin - An `Origin` header value.
 * @returns True when the origin is loopback or absent.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  // `null` is what a sandboxed iframe or a file:// page sends. It names no
  // origin at all, so it cannot be shown to be local.
  if (origin.trim() === 'null') return false
  try {
    const url = new URL(origin.trim())
    return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}
