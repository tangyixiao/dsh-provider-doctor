/**
 * The one stylesheet the browser half injects.
 *
 * Every colour, radius and font comes from the host's own aliases
 * (`--dsw-alias-*`, `--dsw-radius-*`, `--ds-font-family-code`), so the panel
 * follows light/dark and any future theme without a second palette to keep in
 * sync. Nothing here sets `background`/`color` on a host container: the panel
 * only styles its own elements.
 *
 * @module dsh-provider-doctor/client/styles
 */

/** The `data-*` attribute every selector is scoped by. */
export const STYLE_ATTRIBUTE = 'data-provider-doctor'

/** The stylesheet text. */
export const PANEL_CSS = `
[${STYLE_ATTRIBUTE}] {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  font-family: var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}

[${STYLE_ATTRIBUTE}] * { box-sizing: border-box; }

[${STYLE_ATTRIBUTE}] .pd-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

[${STYLE_ATTRIBUTE}] .pd-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}

[${STYLE_ATTRIBUTE}] .pd-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}

[${STYLE_ATTRIBUTE}] .pd-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

[${STYLE_ATTRIBUTE}] .pd-spacer { flex: 1 1 auto; }

[${STYLE_ATTRIBUTE}] .pd-button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: var(--dsw-radius-md);
  padding: 6px 12px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  cursor: pointer;
  transition: background var(--ds-transition-duration, 120ms) var(--ds-ease-in-out, ease);
}

[${STYLE_ATTRIBUTE}] .pd-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }

[${STYLE_ATTRIBUTE}] .pd-button:disabled {
  cursor: not-allowed;
  color: var(--dsw-alias-label-dimmed);
}

[${STYLE_ATTRIBUTE}] .pd-button[data-variant='primary'] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  /*
   * The host pairs this fill with label-primary-foreground, and the pair flips
   * between light and dark: the fill is near-black in one theme and near-white
   * in the other, and the foreground follows it. Hard-coding white (or black)
   * leaves the label invisible in one of the two themes.
   */
  color: var(--dsw-alias-label-primary-foreground, currentColor);
}

[${STYLE_ATTRIBUTE}] .pd-button[data-variant='primary']:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}

[${STYLE_ATTRIBUTE}] .pd-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1));
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

[${STYLE_ATTRIBUTE}] .pd-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

[${STYLE_ATTRIBUTE}] .pd-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

[${STYLE_ATTRIBUTE}] .pd-muted {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

[${STYLE_ATTRIBUTE}] .pd-mono {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
}

[${STYLE_ATTRIBUTE}] .pd-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  font-size: 13px;
  margin: 0;
}

[${STYLE_ATTRIBUTE}] .pd-facts dt { color: var(--dsw-alias-label-secondary); }
[${STYLE_ATTRIBUTE}] .pd-facts dd { margin: 0; word-break: break-word; }

[${STYLE_ATTRIBUTE}] .pd-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex-wrap: wrap;
}

[${STYLE_ATTRIBUTE}] .pd-tab {
  appearance: none;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 13px;
  padding: 8px 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

[${STYLE_ATTRIBUTE}] .pd-tab[data-active='true'] {
  color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
}

[${STYLE_ATTRIBUTE}] .pd-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--dsw-alias-state-idle-primary);
}

[${STYLE_ATTRIBUTE}] .pd-dot[data-status='pass'] { background: var(--dsw-alias-state-success-primary); }
[${STYLE_ATTRIBUTE}] .pd-dot[data-status='warning'] { background: var(--dsw-alias-state-warn-primary); }
[${STYLE_ATTRIBUTE}] .pd-dot[data-status='fail'] { background: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTRIBUTE}] .pd-dot[data-status='timeout'] { background: var(--dsw-alias-state-warn-primary); }

[${STYLE_ATTRIBUTE}] .pd-chain {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

[${STYLE_ATTRIBUTE}] .pd-link {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 10px;
  padding: 10px 8px;
  border-radius: var(--dsw-radius-md);
}

[${STYLE_ATTRIBUTE}] .pd-link + .pd-link { border-top: 1px solid var(--dsw-alias-border-l1); }

[${STYLE_ATTRIBUTE}] .pd-link-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }

[${STYLE_ATTRIBUTE}] .pd-link-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

[${STYLE_ATTRIBUTE}] .pd-link-summary {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}

[${STYLE_ATTRIBUTE}] .pd-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  padding: 1px 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

[${STYLE_ATTRIBUTE}] .pd-badge[data-status='pass'] {
  color: var(--dsw-alias-state-success-primary);
  border-color: currentColor;
}

[${STYLE_ATTRIBUTE}] .pd-badge[data-status='fail'] {
  color: var(--dsw-alias-state-error-primary);
  border-color: currentColor;
}

[${STYLE_ATTRIBUTE}] .pd-badge[data-status='warning'],
[${STYLE_ATTRIBUTE}] .pd-badge[data-status='timeout'] {
  color: var(--dsw-alias-state-warn-primary);
  border-color: currentColor;
}

[${STYLE_ATTRIBUTE}] .pd-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}

[${STYLE_ATTRIBUTE}] .pd-steps li + li { margin-top: 2px; }

[${STYLE_ATTRIBUTE}] .pd-details {
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 8px;
}

[${STYLE_ATTRIBUTE}] .pd-pre {
  margin: 0;
  padding: 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
}

[${STYLE_ATTRIBUTE}] .pd-link-button {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dsw-alias-link, var(--dsw-alias-brand-primary));
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
}

[${STYLE_ATTRIBUTE}] .pd-error {
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

[${STYLE_ATTRIBUTE}] .pd-error-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-state-error-primary);
}

[${STYLE_ATTRIBUTE}] .pd-empty {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: 10px;
  padding: 28px 4px;
}

[${STYLE_ATTRIBUTE}] .pd-footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}

[${STYLE_ATTRIBUTE}] .pd-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`

/** The id the injected `<style>` element carries, so it is replaced not stacked. */
export const STYLE_ELEMENT_ID = 'dsh-provider-doctor-styles'
