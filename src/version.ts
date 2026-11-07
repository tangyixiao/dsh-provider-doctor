/**
 * The loaded build's version.
 *
 * `tsdown` replaces the constant below at build time, so the reported version
 * always names the code that is actually running. A source checkout that was
 * never built reports the development placeholder, which is deliberate: the
 * doctor must not claim a release number it cannot prove.
 *
 * @module dsh-provider-doctor/version
 */

declare const __PROVIDER_DOCTOR_VERSION__: string | undefined

/** Version of the code currently executing. */
export const PLUGIN_VERSION: string =
  typeof __PROVIDER_DOCTOR_VERSION__ === 'string' ? __PROVIDER_DOCTOR_VERSION__ : '0.0.0-dev'
