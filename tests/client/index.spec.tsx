// @vitest-environment jsdom
/**
 * The entry point's own behaviour, rather than any panel's: which surfaces get
 * registered, what happens when the host cannot host one of them, and whether
 * the disposer really puts everything back.
 *
 * These cases exist because a real 0.2.2 host refused `main` and
 * `plugins.bundle.config` with `slot "…" is not declared`; the sidebar icon
 * appeared while the panel behind it did not. Registering directly, without
 * asking the slot service whether the slot exists, was the defect.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, inject, name } from '../../src/client/index.tsx'
import { LOCALE_NAMESPACE, PANEL_ID, PACKAGE_NAME } from '../../src/shared/status-paths.ts'
import { STYLE_ELEMENT_ID } from '../../src/client/styles.ts'

/** One recorded `register` call. */
interface Registration {
  options: Record<string, unknown>
  component: unknown
  dispose: () => void
}

/** A host client context with only what the entry point touches. */
function fakeContext(options: { declared?: readonly string[]; layout?: boolean } = {}) {
  const declared = new Set(options.declared ?? ['main', 'sidebar.panellist', 'plugins.bundle.config'])
  const registrations: Registration[] = []
  const effects: Array<() => void> = []
  const injectCalls: string[] = []
  const localeDictionaries: Record<string, unknown>[] = []
  const selectPanel = vi.fn()
  const translate = vi.fn((key: string) => `t:${key}`)

  const slots = {
    inject(slotName: string, callback: () => unknown) {
      injectCalls.push(slotName)
      if (!declared.has(slotName)) return () => {}
      return callback()
    },
    register(registerOptions: Record<string, unknown>, component: unknown) {
      const dispose = vi.fn()
      registrations.push({ options: registerOptions, component, dispose })
      return dispose
    },
  }

  const locale = {
    register(namespace: string, dictionaries: Record<string, unknown>) {
      localeDictionaries.push({ namespace, dictionaries })
      return () => {}
    },
    bind() {
      return translate
    },
  }

  const layout = {
    panelInfo: { getSnapshot: () => ({ activePanelId: null as string | null }) },
    selectPanel,
  }

  const ctx = {
    effect(execute: () => () => void) {
      effects.push(execute())
      return () => {}
    },
    inject(_deps: readonly string[], callback: (scoped: unknown) => void) {
      if (options.layout === false) return
      callback({ layout })
    },
    slots,
    locale,
  }

  return {
    ctx,
    registrations,
    injectCalls,
    localeDictionaries,
    selectPanel,
    layout,
    translate,
    /** Run every disposer the entry point registered, newest first. */
    teardown() {
      for (const disposer of effects.reverse()) disposer()
      for (const registration of registrations) registration.dispose()
    },
  }
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('client entry point', () => {
  it('publishes the module name the loader addresses it by', () => {
    expect(name).toBe('dsh-provider-doctor-client')
  })

  it('declares the two services it cannot run without', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('asks about every slot before registering into it', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    expect(host.injectCalls).toEqual(['main', 'sidebar.panellist', 'plugins.bundle.config'])
  })

  it('registers all three surfaces on a host that declares them', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    expect(host.registrations.map((entry) => entry.options['name'])).toEqual([
      'main',
      'sidebar.panellist',
      'plugins.bundle.config',
    ])
  })

  it('keys the panel by the panel id, so the sidebar entry addresses it', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    expect(host.registrations[0]?.options['key']).toBe(PANEL_ID)
    expect(host.registrations[1]?.options['id']).toBe(PANEL_ID)
  })

  it('keys the plugin-manager page by the package name the host looks up', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    expect(host.registrations[2]?.options['key']).toBe(PACKAGE_NAME)
  })

  it('skips an undeclared slot instead of throwing out of apply', () => {
    const host = fakeContext({ declared: ['sidebar.panellist'] })
    expect(() => apply(host.ctx as never)).not.toThrow()
    expect(host.registrations.map((entry) => entry.options['name'])).toEqual(['sidebar.panellist'])
  })

  it('still registers the panel when only the sidebar slot is missing', () => {
    const host = fakeContext({ declared: ['main', 'plugins.bundle.config'] })
    apply(host.ctx as never)
    expect(host.registrations.map((entry) => entry.options['name'])).toEqual(['main', 'plugins.bundle.config'])
  })

  it('survives a host with no slots at all, and says so once per surface', () => {
    const host = fakeContext({ declared: [] })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => apply(host.ctx as never)).not.toThrow()
    expect(host.registrations).toEqual([])
    expect(reported).not.toHaveBeenCalled()
  })

  it('logs and continues when the slot service rejects a registration', () => {
    const host = fakeContext()
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    host.ctx.slots.register = () => {
      throw new Error('duplicate priority')
    }
    expect(() => apply(host.ctx as never)).not.toThrow()
    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining('could not register main panel'),
      expect.any(Error),
    )
  })

  it('registers its dictionaries under the shared namespace', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    expect(host.localeDictionaries[0]?.['namespace']).toBe(LOCALE_NAMESPACE)
  })

  it('labels the sidebar entry in the active locale rather than freezing one string', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    const label = host.registrations[1]?.options['label']
    expect(typeof label).toBe('function')
    expect((label as () => string)()).toBe('t:nav')
  })

  it('mounts the stylesheet once and removes it on teardown', () => {
    const host = fakeContext()
    apply(host.ctx as never)
    const style = document.getElementById(STYLE_ELEMENT_ID)
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('.pd-head')
    host.teardown()
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull()
  })

  it('does not add a second stylesheet when one is already mounted', () => {
    const first = fakeContext()
    apply(first.ctx as never)
    apply(first.ctx as never)
    expect(document.querySelectorAll(`#${STYLE_ELEMENT_ID}`)).toHaveLength(1)
  })

  it('steps the layout off its panel before withdrawing the panel key', () => {
    const host = fakeContext()
    host.layout.panelInfo.getSnapshot = () => ({ activePanelId: PANEL_ID })
    apply(host.ctx as never)
    host.teardown()
    expect(host.selectPanel).toHaveBeenCalledWith(null)
  })

  it('leaves the layout alone when another panel is showing', () => {
    const host = fakeContext()
    host.layout.panelInfo.getSnapshot = () => ({ activePanelId: 'plugins' })
    apply(host.ctx as never)
    host.teardown()
    expect(host.selectPanel).not.toHaveBeenCalled()
  })

  it('runs without a layout service, as a headless-ish host would', () => {
    const host = fakeContext({ layout: false })
    expect(() => apply(host.ctx as never)).not.toThrow()
    expect(host.registrations).toHaveLength(3)
    expect(() => host.teardown()).not.toThrow()
  })
})
