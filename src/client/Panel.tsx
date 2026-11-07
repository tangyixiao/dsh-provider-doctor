/**
 * The panel itself.
 *
 * Layout mirrors the question the reader is asking: what is broken, then what
 * do I do about it, then the evidence. So the order is summary → provider
 * chains → redacted report → footer, and the two run controls sit above all of
 * it because choosing *which* check to run is the first decision.
 *
 * The two controls are deliberately not equal. "Basic check" is the safe
 * default and is the primary button; "Connection check" carries its cost in a
 * visible caption, because it starts the provider's own process and may use the
 * signed-in session. A control that hides that would make the plugin's
 * read-only promise a lie.
 *
 * @module dsh-provider-doctor/client/Panel
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ApiFailure } from './api.ts'
import { ChainList } from './ChainList.tsx'
import { HostFacts } from './HostFacts.tsx'
import { SharePanel } from './SharePanel.tsx'
import { createPanelStore, type PanelState, type PanelStore } from './store.ts'
import type { ProviderDoctorKey } from './locales.ts'
import type { Translate } from './format.ts'
import { countBySeverity, verdictOf, worstStatus } from '../shared/snapshot.ts'

/** Props the panel receives from the slot. */
export interface PanelProps {
  t: Translate
}

/**
 * Describe a failed request in the reader's language.
 *
 * @param failure - The classified failure.
 * @param t - The translator.
 * @returns One sentence.
 */
function failureText(failure: ApiFailure, t: Translate): string {
  switch (failure.kind) {
    case 'unauthorized':
      return t('error.unauthorized')
    case 'unreachable':
      return t('error.network')
    case 'bad-payload':
      return t('error.badPayload')
    case 'http':
      return t('error.http', { status: failure.status })
  }
}

/**
 * Render the error card for a failed run.
 *
 * @param props - The failure and the retry callback.
 * @returns The card.
 */
function ErrorCard({
  failure,
  t,
  onRetry,
}: {
  failure: ApiFailure
  t: Translate
  onRetry: () => void
}): ReactNode {
  return (
    <section className="pd-error" role="alert">
      <div className="pd-error-title">{t('error.title')}</div>
      <p className="pd-link-summary" style={{ margin: 0 }}>
        {failureText(failure, t)}
      </p>
      <div className="pd-actions">
        <button
          type="button"
          className="pd-button"
          onClick={() => {
            onRetry()
          }}
        >
          {t('error.retry')}
        </button>
      </div>
    </section>
  )
}

/**
 * The empty / first-run card.
 *
 * @param props - The two run controls.
 * @returns The card.
 */
function EmptyCard({
  t,
  onDiagnose,
}: {
  t: Translate
  onDiagnose: () => void
}): ReactNode {
  return (
    <section className="pd-card">
      <div className="pd-empty">
        <h3 className="pd-card-title">{t('empty.title')}</h3>
        <p className="pd-link-summary" style={{ margin: 0 }}>
          {t('empty.body')}
        </p>
        <p className="pd-muted" style={{ margin: 0 }}>
          {t('empty.connectNote')}
        </p>
        <button
          type="button"
          className="pd-button"
          data-variant="primary"
          onClick={() => {
            onDiagnose()
          }}
        >
          {t('action.runOffline')}
        </button>
      </div>
    </section>
  )
}

/** What the summary strip says for a settled snapshot. */
function SummaryCard({ state, t }: { state: PanelState; t: Translate }): ReactNode {
  const reports = state.snapshot?.reports ?? []
  const checks = reports.flatMap((report) => report.checks)
  const verdict = verdictOf(checks)
  const counts = countBySeverity(checks)
  const status = worstStatus(checks)

  return (
    <section className="pd-card">
      <div className="pd-card-head">
        <span className="pd-dot" data-status={status ?? 'not_checked'} aria-hidden="true" />
        <h3 className="pd-card-title">{t(`summary.${verdict}` as ProviderDoctorKey)}</h3>
        <span className="pd-muted">{t('summary.counts', { ...counts })}</span>
      </div>
      <p className="pd-muted" style={{ margin: 0 }}>
        {t('chain.note')}
      </p>
    </section>
  )
}

/**
 * Render the panel.
 *
 * The store is created once per mount and disposed on unmount, so a panel that
 * is closed and reopened does not keep a dead subscription or an in-flight run.
 *
 * @param props - The translator.
 * @returns The panel.
 */
export function Panel({ t }: PanelProps): ReactNode {
  const [store] = useState<PanelStore>(() => createPanelStore())
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  )

  useEffect(() => {
    void store.load()
    return () => {
      store.dispose()
    }
  }, [store])

  const running = state.phase === 'running'
  const hasSnapshot = state.snapshot !== undefined

  return (
    <div data-provider-doctor="">
      <header className="pd-head">
        <h1 className="pd-title">{t('title')}</h1>
        <p className="pd-subtitle">{t('subtitle')}</p>
      </header>

      <div className="pd-actions">
        <button
          type="button"
          className="pd-button"
          data-variant="primary"
          disabled={running}
          onClick={() => {
            void store.diagnose()
          }}
        >
          {t('action.diagnose')}
        </button>
        <button
          type="button"
          className="pd-button"
          disabled={running}
          title={t('cost.explain')}
          onClick={() => {
            void store.connect()
          }}
        >
          {t('action.connect')}
        </button>
        {running ? (
          <button
            type="button"
            className="pd-button"
            onClick={() => {
              void store.cancel()
            }}
          >
            {t('action.cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="pd-button"
            disabled={!hasSnapshot}
            onClick={() => {
              void store.load()
            }}
          >
            {t('action.refresh')}
          </button>
        )}
        <span className="pd-spacer" />
      </div>

      {state.phase === 'failed' && state.failure !== undefined ? (
        <ErrorCard
          failure={state.failure}
          t={t}
          onRetry={() => {
            void store.load()
          }}
        />
      ) : null}

      {state.phase === 'running' && !hasSnapshot ? (
        <section className="pd-card">
          <div className="pd-card-head">
            <h3 className="pd-card-title">{t('running.title')}</h3>
          </div>
          <p className="pd-muted" style={{ margin: 0 }}>
            {t('running.body')}
          </p>
        </section>
      ) : null}

      {state.phase === 'idle' && !hasSnapshot ? <EmptyCard t={t} onDiagnose={() => void store.diagnose()} /> : null}

      {state.snapshot === undefined ? null : (
        <>
          <SummaryCard state={state} t={t} />
          <HostFacts host={state.snapshot.host} profile={state.snapshot.profile} t={t} />
          <ChainList reports={state.snapshot.reports} failures={state.snapshot.failures} t={t} />
          <SharePanel available t={t} />
        </>
      )}

      <footer className="pd-footer">
        <span>{t('footer.readonlyNotice')}</span>
      </footer>
    </div>
  )
}
