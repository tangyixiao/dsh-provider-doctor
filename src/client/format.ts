/**
 * Small formatting helpers the panel shares.
 *
 * Kept separate from the components so the two facts that are easy to get wrong
 * — how an instant is described, and how a report's numbers are phrased — are
 * testable without React.
 *
 * @module dsh-provider-doctor/client/format
 */

import type { ProviderDoctorKey } from './locales.ts'

/** A translate function over this plugin's own dictionary. */
export type Translate = (key: ProviderDoctorKey, params?: Record<string, unknown>) => string

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Describe an instant relative to now, in the coarsest unit that still reads
 * as useful.
 *
 * The panel only ever shows *when* evidence was collected, so "12 min ago" is
 * enough; an absolute timestamp would leak the machine's time zone into a
 * screenshot without adding information.
 *
 * @param iso - The instant, as an ISO-8601 string.
 * @param t - The translator.
 * @param now - The reference instant; defaults to the current time.
 * @returns A short relative phrase, or the raw string when it is not a date.
 */
export function relativeTime(iso: string, t: Translate, now: number = Date.now()): string {
  const instant = Date.parse(iso)
  if (Number.isNaN(instant)) return iso
  const elapsed = now - instant
  if (elapsed < MINUTE) return t('time.justNow')
  if (elapsed < HOUR) return t('time.minutesAgo', { count: Math.round(elapsed / MINUTE) })
  if (elapsed < DAY) return t('time.hoursAgo', { count: Math.round(elapsed / HOUR) })
  return t('time.daysAgo', { count: Math.round(elapsed / DAY) })
}

/**
 * Render a value as the stable, ordered JSON the details disclosure shows.
 *
 * Details arrive already redacted, so this only has to be readable: keys keep
 * their insertion order and two-space indentation keeps long values scannable.
 *
 * @param value - The detail record.
 * @returns Pretty-printed JSON, or an empty string when there is nothing to show.
 */
export function prettyDetails(value: Readonly<Record<string, unknown>> | undefined): string {
  if (value === undefined) return ''
  const keys = Object.keys(value)
  if (keys.length === 0) return ''
  return JSON.stringify(value, null, 2)
}
