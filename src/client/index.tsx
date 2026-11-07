/**
 * The browser half's entry point.
 *
 * It contributes three surfaces that all render the same {@link Panel}: the
 * sidebar entry with its matching `main` view, and one page inside the plugin
 * manager so the same report is reachable from where the user already manages
 * plugins. One component means one implementation of "diagnose" and no second
 * copy of the rules to drift.
 *
 * Registration is guarded per contribution. A host build that does not declare
 * the sidebar slot (an older client, a headless profile) must not take the whole
 * plugin down with it, so a failed registration logs and returns a no-op
 * disposer instead of throwing out of `apply`.
 *
 * @module dsh-provider-doctor/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LOCALE_NAMESPACE, PANEL_ID, PACKAGE_NAME } from '../shared/status-paths.ts'
import { PLUGIN_VERSION } from '../version.ts'
import { DoctorIcon } from './icons.tsx'
import { Panel } from './Panel.tsx'
import { PANEL_CSS, STYLE_ATTRIBUTE, STYLE_ELEMENT_ID } from './styles.ts'
import { en, zh, type ProviderDoctorKey } from './locales.ts'

/** The name Cordis and the module loader address this client half by. */
export const name = 'dsh-provider-doctor-client'

/** Services this half needs before `apply` runs. */
export const inject = ['slots', 'locale']

/** A disposer that does nothing, so a skipped contribution still has one. */
const NOOP_DISPOSER = (): void => {}

/** The translator shape this plugin publishes under its namespace. */
type Translate = (key: ProviderDoctorKey, params?: Record<string, unknown>) => string

/**
 * The parts of the host's client context this half touches.
 *
 * Declared locally rather than imported so the bundle keeps no compile-time
 * dependency on one exact host client-context type: these members are the ones
 * every 0.2.x client provides.
 */
interface SlotsFace {
  inject(slotName: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface LocaleFace {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
}

interface LayoutFace {
  readonly panelInfo: { getSnapshot(): { activePanelId: string | null } }
  selectPanel(id: string | null): void
}

/** The client context as far as this plugin is concerned. */
interface ClientContext extends Context {
  slots: SlotsFace
  locale: LocaleFace
}

/**
 * Normalise a registration's return value into a disposer.
 *
 * @param value - Whatever the slot service returned.
 * @returns A callable disposer.
 */
function asDisposer(value: unknown): () => void {
  return typeof value === 'function' ? (value as () => void) : NOOP_DISPOSER
}

/**
 * Register one contribution, degrading to a no-op when the host cannot host it.
 *
 * @param label - What is being registered, for the log line.
 * @param fn - The registration itself.
 * @returns The contribution's disposer, or a no-op.
 */
function guardContribution(label: string, fn: () => unknown): () => void {
  try {
    return asDisposer(fn())
  } catch (error) {
    console.error(`[dsh-provider-doctor] could not register ${label}`, error)
    return NOOP_DISPOSER
  }
}

/**
 * Add the panel stylesheet once, and remove it when the plugin unloads.
 *
 * @returns The remover.
 */
function mountStyles(): () => void {
  if (typeof document === 'undefined') return NOOP_DISPOSER
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return NOOP_DISPOSER
  const element = document.createElement('style')
  element.id = STYLE_ELEMENT_ID
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = PANEL_CSS
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

/**
 * Mount the browser half.
 *
 * @param ctx - The client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }))
  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  ctx.effect(() => mountStyles())

  // `layout` is only present when the host ships its layout service. Holding the
  // reference lets the disposer step the layout off a panel key it is about to
  // remove, which would otherwise leave the sidebar pointing at nothing.
  let layout: LayoutFace | undefined
  ctx.inject(['layout'], (scoped) => {
    layout = (scoped as unknown as { layout?: LayoutFace }).layout
  })

  const offPanel = guardContribution('main panel', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: LOCALE_NAMESPACE, inject: () => ({ t }) },
      () => <Panel t={t} />,
    ),
  )

  const offSidebar = guardContribution('sidebar entry', () =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: () => t('nav'),
          locale: LOCALE_NAMESPACE,
        },
        (owner: { size?: number }) => <DoctorIcon size={owner.size ?? 16} />,
      ),
    ),
  )

  const offBundlePage = guardContribution('bundle configuration page', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: LOCALE_NAMESPACE,
        inject: () => ({ t }),
      },
      (props: { view?: string }) => (props.view === 'page' ? <Panel t={t} /> : null),
    ),
  )

  ctx.effect(
    () => () => {
      if (layout?.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null)
      offSidebar()
      offBundlePage()
      offPanel()
    },
  )

  console.info(`[dsh-provider-doctor] client ${PLUGIN_VERSION} ready`)
}
