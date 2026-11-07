/**
 * One link in the connection chain.
 *
 * The row leads with the verdict dot because that is the question the reader
 * arrived with ("where does it break?"), then the link's name, then the status
 * word as text — the dot alone would be unreadable for anyone who cannot
 * distinguish the colours, and a status word is also what they will quote back
 * into a bug report.
 *
 * Two badges carry the honesty rules the contract cares about: the cost badge
 * says whether the link needs a process/network at all, and the evidence badge
 * says whether the doctor actually saw the thing or is inferring it.
 *
 * @module dsh-provider-doctor/client/CheckRow
 */

import { useState, type ReactNode } from 'react'
import type { CheckResult } from '../shared/contract.ts'
import type { ProviderDoctorKey } from './locales.ts'
import { prettyDetails, relativeTime, type Translate } from './format.ts'

/** Props of one chain row. */
export interface CheckRowProps {
  check: CheckResult
  t: Translate
}

/** The status word, as a dictionary key. */
function statusKey(status: CheckResult['status']): ProviderDoctorKey {
  return `status.${status}` as ProviderDoctorKey
}

/** The check name, as a dictionary key. */
function nameKey(id: CheckResult['id']): ProviderDoctorKey {
  return `check.${id}` as ProviderDoctorKey
}

/** The evidence word, as a dictionary key. */
function evidenceKey(kind: CheckResult['evidenceKind']): ProviderDoctorKey {
  return `evidence.${kind}` as ProviderDoctorKey
}

/**
 * Render one link.
 *
 * @param props - The check and the translator.
 * @returns The row, including its disclosures.
 */
export function CheckRow({ check, t }: CheckRowProps): ReactNode {
  const [open, setOpen] = useState(false)
  const details = prettyDetails(check.details)
  const steps = check.nextSteps.filter((step) => step.trim().length > 0)
  const expandable = details.length > 0 || steps.length > 0

  return (
    <li className="pd-link">
      <span className="pd-dot" data-status={check.status} aria-hidden="true" />
      <div className="pd-link-body">
        <div className="pd-link-name">
          <span>{t(nameKey(check.id))}</span>
          <span className="pd-badge" data-status={check.status}>
            {t(statusKey(check.status))}
          </span>
          <span className="pd-badge" title={t('cost.explain')}>
            {check.cost === 'offline' ? t('cost.offline') : t('cost.sideEffecting')}
          </span>
          <span className="pd-badge">{t(evidenceKey(check.evidenceKind))}</span>
        </div>
        <div className="pd-link-summary">{check.summary}</div>
        {expandable ? (
          <div className="pd-details">
            <button
              type="button"
              className="pd-link-button"
              aria-expanded={open}
              onClick={() => {
                setOpen((previous) => !previous)
              }}
            >
              {open ? t('action.hideDetails') : t('action.details')}
            </button>
            {open ? (
              <>
                {steps.length > 0 ? (
                  <>
                    <h4 className="pd-card-title" style={{ marginTop: 8 }}>
                      {t('nextSteps.title')}
                    </h4>
                    <ul className="pd-steps">
                      {steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {details.length > 0 ? <pre className="pd-pre">{details}</pre> : null}
                <div className="pd-muted" style={{ marginTop: 6 }}>
                  {relativeTime(check.observedAt, t)} · {t(`source.${check.source}` as ProviderDoctorKey)}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="pd-muted">
            {relativeTime(check.observedAt, t)} · {t(`source.${check.source}` as ProviderDoctorKey)}
          </div>
        )}
      </div>
      <span className="pd-sr-only">{t(statusKey(check.status))}</span>
    </li>
  )
}
