/**
 * The route table, shared by the Host half that registers the routes and the
 * browser half that calls them.
 *
 * Both halves are separate bundles: the Host half is ESM running in the Electron
 * main process, the browser half is a CommonJS factory running in the renderer.
 * They can therefore only agree on facts that are pure data, which is why the
 * paths live here and nowhere else. A path spelled in two files is a path that
 * will eventually be spelled differently in one of them.
 *
 * @module dsh-provider-doctor/shared/status-paths
 */

/** The URL prefix every doctor route shares, namespaced by package name. */
export const PLUGIN_ROUTE_PREFIX = '/plugins/dsh-provider-doctor'

/** The side-effect-free snapshot route. */
export const STATUS_PATH = `${PLUGIN_ROUTE_PREFIX}/status`

/** The route that runs the offline checks. */
export const DIAGNOSE_PATH = `${PLUGIN_ROUTE_PREFIX}/diagnose`

/** The route that runs the offline checks *and* the side-effecting connection check. */
export const CONNECT_PATH = `${PLUGIN_ROUTE_PREFIX}/connect`

/** The route that aborts an in-flight run. */
export const CANCEL_PATH = `${PLUGIN_ROUTE_PREFIX}/cancel`

/** The route that returns the redacted, pasteable document. */
export const SHARE_PATH = `${PLUGIN_ROUTE_PREFIX}/share`

/** The sidebar panel id; the layout's `main` slot is keyed by the same string. */
export const PANEL_ID = 'dsh-provider-doctor'

/** This plugin's npm package name, used for locale namespacing and slot keys. */
export const PACKAGE_NAME = 'dsh-provider-doctor'

/** The locale namespace the browser half registers its strings under. */
export const LOCALE_NAMESPACE = PACKAGE_NAME
