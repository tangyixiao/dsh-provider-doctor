/**
 * The host facts card.
 *
 * Two facts here are load-bearing for every conclusion below them:
 * which DSH build produced the evidence, and which profile it was read from.
 * A version that could not be read is shown as such — never as a plausible
 * default — because a wrong version would send the reader chasing the wrong
 * incompatibility.
 *
 * Absolute paths stay behind a disclosure. They are useful when the person is
 * looking at their own machine and useless-but-revealing anywhere else (a
 * screenshot, a shared screen, a pasted report), so the default is hidden.
 *
 * @module dsh-provider-doctor/client/HostFacts
 */

import { useState, type ReactNode } from 'react'
import type { HostFactsView, ProfileFactsView } from '../shared/snapshot.ts'
import type { ProviderDoctorKey } from './locales.ts'
import type { Translate } from './format.ts'

/** Props of the host facts card. */
export interface HostFactsProps {
  host: HostFactsView
  profile: ProfileFactsView
  t: Translate
}

/**
 * Render one definition row.
 *
 * @param props - The label key and the value.
 * @returns The row's two cells.
 */
function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

/**
 * Render the host card.
 *
 * @param props - The host facts, the profile facts and the translator.
 * @returns The card.
 */
export function HostFacts({ host, profile, t }: HostFactsProps): ReactNode {
  const [showPaths, setShowPaths] = useState(false)
  const hasPaths = host.dshHome.length > 0 || profile.dir !== undefined

  return (
    <section className="pd-card">
      <div className="pd-card-head">
        <h3 className="pd-card-title">{t('host.title')}</h3>
        {hasPaths ? (
          <button
            type="button"
            className="pd-link-button"
            aria-pressed={showPaths}
            onClick={() => {
              setShowPaths((previous) => !previous)
            }}
          >
            {showPaths ? t('action.hidePaths') : t('action.revealPaths')}
          </button>
        ) : null}
      </div>
      <dl className="pd-facts">
        <Fact label={t('host.dshVersion')}>
          {host.dshVersion === undefined ? (
            <span className="pd-muted">{t('host.dshVersionUnknown')}</span>
          ) : (
            <span className="pd-mono">{host.dshVersion}</span>
          )}
          <span className="pd-muted">
            {' '}
            · {t(`host.dshVersionSource.${host.dshVersionSource}` as ProviderDoctorKey)}
          </span>
        </Fact>
        <Fact label={t('host.node')}>
          <span className="pd-mono">{host.nodeVersion}</span>
        </Fact>
        <Fact label={t('host.platform')}>
          <span className="pd-mono">
            {host.platform}/{host.arch}
          </span>
        </Fact>
        <Fact label={t('host.profile')}>
          {profile.name === undefined ? (
            <span className="pd-muted">{t('host.profileUnknown')}</span>
          ) : (
            <span className="pd-mono">{profile.name}</span>
          )}
          {profile.candidates.length > 1 ? (
            <span className="pd-muted">
              {' '}
              · {t('host.profileCandidates', { names: profile.candidates.join(', ') })}
            </span>
          ) : null}
        </Fact>
        {showPaths ? (
          <>
            <Fact label={t('host.dshHome')}>
              <span className="pd-mono">{host.dshHome}</span>
            </Fact>
            {profile.dir === undefined ? null : (
              <Fact label={t('host.profileDir')}>
                <span className="pd-mono">{profile.dir}</span>
              </Fact>
            )}
          </>
        ) : null}
      </dl>
      {profile.candidates.length > 1 && profile.evidence !== 'observed' ? (
        <p className="pd-muted" style={{ margin: 0 }}>
          {t('host.profileAmbiguous')}
        </p>
      ) : null}
    </section>
  )
}
