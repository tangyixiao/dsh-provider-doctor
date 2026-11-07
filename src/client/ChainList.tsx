/**
 * One provider's connection chain.
 *
 * The card reads from the top: a verdict word, then the counts that produced
 * it, then the links themselves in chain order. Showing the counts next to the
 * verdict keeps a "broken" from looking bigger than it is — one failing link
 * among nine passing ones is a different message from nine broken links.
 *
 * A provider whose adapter failed outright gets its card too, with the failure
 * text: silence would read as "this provider is fine".
 *
 * @module dsh-provider-doctor/client/ChainList
 */

import type { ReactNode } from 'react'
import { PROVIDER_IDS, type DiagnosticReport, type ProviderId } from '../shared/contract.ts'
import { countBySeverity, verdictOf, worstStatus, type ProviderFailure } from '../shared/snapshot.ts'
import { CheckRow } from './CheckRow.tsx'
import type { ProviderDoctorKey } from './locales.ts'
import type { Translate } from './format.ts'

/** Props of one provider card. */
export interface ProviderCardProps {
  provider: ProviderId
  report: DiagnosticReport | undefined
  failure: ProviderFailure | undefined
  t: Translate
}

/** The dictionary key naming a provider. */
function providerKey(provider: ProviderId): ProviderDoctorKey {
  return `provider.${provider}` as ProviderDoctorKey
}

/**
 * Render the provider's headline: verdict word, plugin identity, counts.
 *
 * @param props - The report (when there is one) and the translator.
 * @returns The header block.
 */
function ProviderHeadline({ report, t }: { report: DiagnosticReport; t: Translate }): ReactNode {
  const verdict = verdictOf(report.checks)
  const counts = countBySeverity(report.checks)
  const worst = worstStatus(report.checks)

  return (
    <div className="pd-card-head">
      <span className="pd-dot" data-status={worst ?? 'unknown'} aria-hidden="true" />
      <h3 className="pd-card-title">{t(providerKey(report.provider))}</h3>
      <span className="pd-badge" data-status={verdict === 'broken' ? 'fail' : verdict === 'healthy' ? 'pass' : 'unknown'}>
        {t(`summary.${verdict}` as ProviderDoctorKey)}
      </span>
      <span className="pd-muted">
        {t('summary.counts', {
          pass: counts.pass,
          warning: counts.warning,
          fail: counts.fail,
          unresolved: counts.unresolved,
        })}
      </span>
      <span className="pd-muted">
        {report.plugin.name}
        {report.plugin.version === undefined ? '' : ` ${report.plugin.version}`}
      </span>
    </div>
  )
}

/**
 * Render one provider card.
 *
 * @param props - The provider, its report or failure, and the translator.
 * @returns The card.
 */
export function ProviderCard({ provider, report, failure, t }: ProviderCardProps): ReactNode {
  if (report === undefined) {
    return (
      <section className="pd-card">
        <div className="pd-card-head">
          <span className="pd-dot" data-status="unknown" aria-hidden="true" />
          <h3 className="pd-card-title">{t(providerKey(provider))}</h3>
        </div>
        <div>
          <div className="pd-error-title">{t('failure.title')}</div>
          <p className="pd-link-summary" style={{ margin: 0 }}>
            {failure?.message ?? t('providers.empty')}
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="pd-card">
      <ProviderHeadline report={report} t={t} />
      <ol className="pd-chain">
        {report.checks.map((check) => (
          <CheckRow key={check.id} check={check} t={t} />
        ))}
      </ol>
    </section>
  )
}

/**
 * Render every provider the run produced, in the contract's display order.
 *
 * @param props - The reports, the failures, and the translator.
 * @returns One card per provider that the host has an adapter for.
 */
export function ChainList({
  reports,
  failures,
  t,
}: {
  reports: readonly DiagnosticReport[]
  failures: readonly ProviderFailure[]
  t: Translate
}): ReactNode {
  const reported = new Set(reports.map((report) => report.provider))
  const failed = new Map(failures.map((failure) => [failure.provider, failure]))
  const present = PROVIDER_IDS.filter((provider) => reported.has(provider) || failed.has(provider))

  if (present.length === 0) {
    return (
      <section className="pd-card">
        <p className="pd-muted" style={{ margin: 0 }}>
          {t('providers.empty')}
        </p>
      </section>
    )
  }

  return (
    <>
      {present.map((provider) => (
        <ProviderCard
          key={provider}
          provider={provider}
          report={reports.find((report) => report.provider === provider)}
          failure={failed.get(provider)}
          t={t}
        />
      ))}
    </>
  )
}
