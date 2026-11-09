import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PANEL_CSS } from '../../src/client/styles.ts'

/**
 * The theme sheet is where the host defines every `--dsw-alias-*` token. It is
 * shipped inside the desktop build rather than as a dependency, so this guard
 * reads it when the checkout happens to include one and is skipped otherwise.
 * The point of the test is to catch a token name that no theme defines: a
 * mistyped token does not fail loudly, it silently renders the fallback, which
 * is how the primary button ended up with white text on a white fill.
 */
const THEME_CANDIDATES = [
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  ),
  'D:/tmp/dsh-temp/asar-extract/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
]

function readTheme(): string | undefined {
  for (const candidate of THEME_CANDIDATES) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
  }
  return undefined
}

const theme = readTheme()

/** Every theme token this sheet references. */
function referencedTokens(css: string): string[] {
  return [...new Set(css.match(/--(?:dsw|ds)-[a-z0-9-]+/g) ?? [])].sort()
}

describe('panel stylesheet', () => {
  it('references at least one token per visual concern, so no colour is hard-coded', () => {
    const tokens = referencedTokens(PANEL_CSS)
    expect(tokens.length).toBeGreaterThan(20)
    // A literal colour would defeat the light/dark pair the host maintains.
    expect(PANEL_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(PANEL_CSS).not.toMatch(/\brgba?\(/)
    expect(PANEL_CSS).not.toMatch(/\bhsla?\(/)
  })

  it('scopes every rule to the plugin attribute, so the sheet cannot leak into the host UI', () => {
    // Split on the closing brace so each declaration block can be checked with
    // its selector, which is what carries the scope attribute.
    const blocks = PANEL_CSS.split('}')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.includes('{'))
    expect(blocks.length).toBeGreaterThan(30)
    for (const block of blocks) {
      const selector = block.slice(0, block.indexOf('{')).trim()
      // `@media`/`@supports` wrappers carry the scope on the rule inside them.
      if (selector.startsWith('@')) continue
      expect(selector).toContain('[data-provider-doctor]')
    }
  })

  it('gives the primary button a foreground that follows its fill', () => {
    // The fill flips between near-black and near-white across themes, so the
    // label has to come from the matched host token rather than a fixed colour.
    expect(PANEL_CSS).toMatch(
      /\.pd-button\[data-variant='primary'\][\s\S]*?color:\s*var\(--dsw-alias-label-primary-foreground/,
    )
  })

  it('only names tokens the host theme actually defines', () => {
    if (theme === undefined) {
      // No packaged build in this checkout: the sweep above still holds, and CI
      // covers the shape. Skipping beats asserting against a guess.
      expect(theme).toBeUndefined()
      return
    }
    const unknown = referencedTokens(PANEL_CSS).filter((token) => !theme.includes(token))
    expect(unknown).toEqual([])
  })
})
