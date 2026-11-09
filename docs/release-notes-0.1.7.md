# 0.1.7 release notes

A visual fix found by running the released plugin inside the packaged
desktop app rather than a headless host.

## Changes

- The primary button in the panel was an empty white box in the dark theme.
  Its fill came from `--dsw-alias-button-primary-fill` while its label fell
  back to `#fff`, because `--dsw-alias-label-inverse` — the token named in the
  previous stylesheet — is not defined by this host's theme. The label now uses
  `--dsw-alias-label-primary-foreground`, the token the host pairs with that
  fill and which flips with the theme, so fill and label can no longer disagree
  (3130df3).
- Separators referenced `--dsw-alias-separator-primary`, which is likewise
  undefined here; every divider was falling back to `currentColor` and reading
  as a heavy rule. They now use `--dsw-alias-border-l1` (3130df3).
- `tests/client/styles.spec.ts` (4 cases) guards the shape instead of the
  incident: no literal colours, every rule scoped to the plugin attribute, the
  primary label tracking its fill, and — when a packaged build is present —
  every referenced token checked against the host theme sheet. Reverting the
  fix fails three of the four.

## Verification

- `pnpm run check` — both typechecks, 24 files / 505 cases, build.
- The packaged desktop app (`DeepSeek Harness 0.2.2-rc.1`, isolated
  `DSH_HOME` and `--user-data-dir`) renders the panel with a readable primary
  label, and a basic run from that window completes and shows the summary.
  This is the check that found the defect: a headless host renders the same
  CSS, but the earlier acceptance never looked at the button.

Local automated checks do not establish that the published tarball installs in
a fresh host, that other operating systems behave the same, or that the market
index and the community directories have picked the release up. Those are
checked separately after publication.
