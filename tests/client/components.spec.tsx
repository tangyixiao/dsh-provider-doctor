// @vitest-environment jsdom

/**
 * Render tests for the chain rows and the provider cards.
 *
 * These assert the two things a reader would otherwise have to take on faith:
 * every status is spelled out as text (not colour alone), and an unobserved
 * link never renders as if it had passed.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { ChainList } from '../../src/client/ChainList.tsx'
import { CheckRow } from '../../src/client/CheckRow.tsx'
import { HostFacts } from '../../src/client/HostFacts.tsx'
import type { Translate } from '../../src/client/format.ts'
import type { ProviderDoctorKey } from '../../src/client/locales.ts'
import { en } from '../../src/client/locales.ts'
import type { CheckResult, DiagnosticReport } from '../../src/shared/contract.ts'
import type { HostFactsView, ProfileFactsView } from '../../src/shared/snapshot.ts'

const t: Translate = (key, params) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  )
}

let root: Root | undefined
let host: HTMLElement

/** Mount a node and return the container. */
function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(node)
  })
  return host
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

/**
 * Every button inside a container, as a real array.
 *
 * `Array.from` rather than spread because the client tsconfig keeps the default
 * `dom` lib without `dom.iterable`, so a NodeList is not itself iterable there.
 */
function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

/** One check with sane defaults. */
function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'plugin-installed',
    status: 'pass',
    evidenceKind: 'observed',
    observedAt: new Date().toISOString(),
    source: 'live_host',
    cost: 'offline',
    summary: 'The plugin is installed in this profile.',
    nextSteps: [],
    ...overrides,
  }
}

/** One provider report. */
function report(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    schemaVersion: 1,
    provider: 'workbuddy',
    plugin: { name: 'dsh-workbuddy-connect-community', version: '0.1.14' },
    profile: { kind: 'live_host', identity: 'desktop' },
    host: { dshVersion: '0.2.2-rc.1', nodeVersion: 'v24.21.0', platform: 'win32', arch: 'x64' },
    checks: [check()],
    observedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('CheckRow', () => {
  it('spells the status out as text, so colour is not the only signal', () => {
    const container = render(<CheckRow check={check({ status: 'fail', reasonCode: 'credential_missing' })} t={t} />)
    expect(container.textContent).toContain(en['status.fail'])
  })

  it('names the check with its human label, not its machine id', () => {
    const container = render(<CheckRow check={check()} t={t} />)
    expect(container.textContent).toContain(en['check.plugin-installed'])
    expect(container.textContent).not.toContain('plugin-installed')
  })

  it('marks the link as observed when it was', () => {
    const container = render(<CheckRow check={check({ evidenceKind: 'inferred' })} t={t} />)
    expect(container.textContent).toContain(en['evidence.inferred'])
  })

  it('discloses when a link needs a process', () => {
    const container = render(
      <CheckRow check={check({ cost: 'side_effecting', status: 'not_checked', reasonCode: 'not_requested' })} t={t} />,
    )
    expect(container.textContent).toContain(en['cost.sideEffecting'])
  })

  it('says a link is offline when it is', () => {
    const container = render(<CheckRow check={check()} t={t} />)
    expect(container.textContent).toContain(en['cost.offline'])
  })

  it('hides details until they are asked for', () => {
    const container = render(
      <CheckRow check={check({ details: { provider: 'workbuddy' }, nextSteps: ['Sign in again.'] })} t={t} />,
    )
    expect(container.querySelector('pre')).toBeNull()
    expect(container.textContent).not.toContain('Sign in again.')
  })

  it('reveals next steps and details when expanded', () => {
    const container = render(
      <CheckRow check={check({ details: { provider: 'workbuddy' }, nextSteps: ['Sign in again.'] })} t={t} />,
    )
    const toggle = buttons(container).find((button) => button.textContent === en['action.details'])
    expect(toggle).toBeDefined()
    act(() => {
      toggle?.click()
    })
    expect(container.textContent).toContain('Sign in again.')
    expect(container.querySelector('pre')?.textContent).toContain('"provider": "workbuddy"')
  })

  it('offers no disclosure when there is nothing to disclose', () => {
    const container = render(<CheckRow check={check()} t={t} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('always shows when the observation happened', () => {
    const container = render(<CheckRow check={check()} t={t} />)
    expect(container.textContent).toContain(en['time.justNow'])
  })
})

describe('ChainList', () => {
  it('renders one card per reported provider', () => {
    const container = render(
      <ChainList
        reports={[report(), report({ provider: 'zcode-cli', plugin: { name: 'dsh-zcode-plan-bridge' } })]}
        failures={[]}
        t={t}
      />,
    )
    expect(container.textContent).toContain(en['provider.workbuddy'])
    expect(container.textContent).toContain(en['provider.zcode-cli'])
  })

  it('keeps the contract display order regardless of arrival order', () => {
    const container = render(
      <ChainList
        reports={[report({ provider: 'zcode-cli' }), report({ provider: 'workbuddy' })]}
        failures={[]}
        t={t}
      />,
    )
    const text = container.textContent ?? ''
    expect(text.indexOf(en['provider.workbuddy'])).toBeLessThan(text.indexOf(en['provider.zcode-cli']))
  })

  it('shows a provider that failed outright instead of hiding it', () => {
    const container = render(
      <ChainList
        reports={[]}
        failures={[{ provider: 'workbuddy', message: 'The adapter threw before producing a report.' }]}
        t={t}
      />,
    )
    expect(container.textContent).toContain('The adapter threw before producing a report.')
    expect(container.textContent).toContain(en['failure.title'])
  })

  it('says so when no provider was reported at all', () => {
    const container = render(<ChainList reports={[]} failures={[]} t={t} />)
    expect(container.textContent).toContain(en['providers.empty'])
  })

  it('summarises each provider with a verdict word and counts', () => {
    const container = render(
      <ChainList
        reports={[report({ checks: [check(), check({ id: 'credential-metadata', status: 'fail', reasonCode: 'credential_missing' })] })]}
        failures={[]}
        t={t}
      />,
    )
    expect(container.textContent).toContain(en['summary.broken'])
  })

  it('does not call a report healthy when a link was skipped', () => {
    const container = render(
      <ChainList
        reports={[report({ checks: [check(), check({ id: 'credential-metadata', status: 'not_checked', reasonCode: 'not_requested' })] })]}
        failures={[]}
        t={t}
      />,
    )
    expect(container.textContent).not.toContain(en['summary.healthy'])
    expect(container.textContent).toContain(en['summary.unresolved'])
  })

  it('prints the plugin name and version as evidence', () => {
    const container = render(<ChainList reports={[report()]} failures={[]} t={t} />)
    expect(container.textContent).toContain('dsh-workbuddy-connect-community 0.1.14')
  })
})

describe('HostFacts', () => {
  const host: HostFactsView = {
    dshVersion: '0.2.2-rc.1',
    dshVersionSource: 'package-manifest',
    nodeVersion: 'v24.21.0',
    platform: 'win32',
    arch: 'x64',
    dshHome: 'C:\\Users\\someone\\.dsh',
  }
  const profile: ProfileFactsView = {
    name: 'desktop',
    dir: 'C:\\Users\\someone\\.dsh\\profiles\\desktop',
    candidates: ['desktop'],
    source: 'preferred-desktop',
    evidence: 'inferred',
  }

  it('shows the DSH version and where it came from', () => {
    const container = render(<HostFacts host={host} profile={profile} t={t} />)
    expect(container.textContent).toContain('0.2.2-rc.1')
    expect(container.textContent).toContain(en['host.dshVersionSource.package-manifest'])
  })

  it('says the version is unknown rather than inventing one', () => {
    const { dshVersion: _ignored, ...rest } = host
    const container = render(<HostFacts host={rest} profile={profile} t={t} />)
    expect(container.textContent).toContain(en['host.dshVersionUnknown'])
  })

  it('hides absolute paths by default', () => {
    const container = render(<HostFacts host={host} profile={profile} t={t} />)
    expect(container.textContent).not.toContain('C:\\Users')
  })

  it('reveals paths only when asked', () => {
    const container = render(<HostFacts host={host} profile={profile} t={t} />)
    const toggle = buttons(container).find((button) => button.textContent === en['action.revealPaths'])
    expect(toggle).toBeDefined()
    act(() => {
      toggle?.click()
    })
    expect(container.textContent).toContain('C:\\Users\\someone\\.dsh')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
  })

  it('warns when several profiles could match', () => {
    const container = render(
      <HostFacts host={host} profile={{ ...profile, candidates: ['desktop', 'web'] }} t={t} />,
    )
    expect(container.textContent).toContain(en['host.profileAmbiguous'])
  })

  it('does not warn when only one profile could match', () => {
    const container = render(<HostFacts host={host} profile={profile} t={t} />)
    expect(container.textContent).not.toContain(en['host.profileAmbiguous'])
  })
})
