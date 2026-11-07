/**
 * The DSH range this build was verified against.
 *
 * The value comes from this package's own `engines.dsh`, which is the same field
 * DSH's plugin manager reads before it loads a bundle. Using it here means the
 * doctor and the loader answer "is this build supported" from one fact, so a
 * diagnosis can never disagree with the install that produced it.
 *
 * `tsdown` inlines the range at build time. A source checkout that was never
 * built falls back to reading its own manifest, and if even that fails the range
 * degrades to `*` — which {@link checkEngineRange} treats as "no claim", not as
 * "everything is fine".
 *
 * @module dsh-provider-doctor/host/engine-range
 */

import { readFileSync } from 'node:fs'

declare const __PROVIDER_DOCTOR_DSH_RANGE__: string | undefined

/**
 * The range used when neither the build constant nor the manifest is readable.
 *
 * `*` is deliberately chosen over a pinned version: claiming a specific range
 * this build never declared would turn an unreadable manifest into a confident
 * compatibility statement.
 */
const UNCONSTRAINED = '*'

/** The `engines.dsh` range of the code currently executing. */
export const DSH_ENGINE_RANGE: string =
  typeof __PROVIDER_DOCTOR_DSH_RANGE__ === 'string'
    ? __PROVIDER_DOCTOR_DSH_RANGE__
    : readOwnEngineRange() ?? UNCONSTRAINED

/**
 * Read `engines.dsh` out of this package's manifest, next to the running file.
 *
 * Best-effort by design: this runs when the build constant is absent, which is
 * exactly the situation (a source checkout, or an unusual bundling) where the
 * manifest may also not be where it usually is.
 *
 * @returns The declared range, or `undefined` when it could not be read.
 */
function readOwnEngineRange(): string | undefined {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const engines = (parsed as { engines?: unknown }).engines
    if (typeof engines !== 'object' || engines === null) return undefined
    const dsh = (engines as { dsh?: unknown }).dsh
    return typeof dsh === 'string' && dsh.trim() !== '' ? dsh.trim() : undefined
  } catch {
    return undefined
  }
}
