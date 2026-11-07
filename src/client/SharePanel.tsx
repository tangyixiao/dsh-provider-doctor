/**
 * The redacted-report card.
 *
 * Its whole job is to make the *shape* of what leaves the machine visible before
 * it leaves: the same whitelist-only document the copy control puts on the
 * clipboard is shown, in full, above the button. There is no "prepare for
 * sharing" transform hiding between the preview and the copy.
 *
 * When no run has produced a document yet, the card says so instead of
 * offering a copy button that would fail.
 *
 * @module dsh-provider-doctor/client/SharePanel
 */

import { useState, type ReactNode } from 'react'
import type { ShareableReport } from '../shared/contract.ts'
import { fetchShareable, formatShareable, copyText } from './api.ts'
import type { Translate } from './format.ts'

/** Props of the share card. */
export interface SharePanelProps {
  /** Whether a snapshot exists to derive a document from. */
  available: boolean
  t: Translate
}

/** What the copy control is showing right now. */
type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Render the card.
 *
 * @param props - Availability and the translator.
 * @returns The card.
 */
export function SharePanel({ available, t }: SharePanelProps): ReactNode {
  const [document, setDocument] = useState<ShareableReport | undefined>(undefined)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [busy, setBusy] = useState(false)

  const onCopy = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await fetchShareable()
      if (!result.ok) {
        setCopyState('failed')
        return
      }
      setDocument(result.value)
      const copied = await copyText(formatShareable(result.value))
      setCopyState(copied ? 'copied' : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pd-card">
      <div className="pd-card-head">
        <h3 className="pd-card-title">{t('share.title')}</h3>
      </div>
      <p className="pd-muted" style={{ margin: 0 }}>
        {t('share.note')}
      </p>
      {!available ? (
        <p className="pd-muted" style={{ margin: 0 }}>
          {t('share.notReady')}
        </p>
      ) : (
        <>
          <div className="pd-actions">
            <button
              type="button"
              className="pd-button"
              disabled={busy}
              onClick={() => {
                void onCopy()
              }}
            >
              {copyState === 'copied' ? t('action.copied') : t('action.copy')}
            </button>
            {copyState === 'copied' ? <span className="pd-muted">{t('share.ready')}</span> : null}
            {copyState === 'failed' ? <span className="pd-error-title">{t('action.copyFailed')}</span> : null}
          </div>
          {document === undefined ? null : <pre className="pd-pre">{formatShareable(document)}</pre>}
        </>
      )}
    </section>
  )
}
