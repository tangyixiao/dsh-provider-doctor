# 0.1.3 release notes

This patch carries WorkBuddy's own diagnostic hints into the report without copying their free text, and refreshes the test counts. The DSH compatibility declaration remains `0.2.2-rc.1`.

## Changes

- WorkBuddy 0.1.15 prints a `hints` array, and one of those sentences says the host bundle is not running in the current DSH profile. `src/providers/workbuddy/plugin-package.ts` now reduces that array to a single fixed token and drops every other sentence, so a wording change upstream degrades to "no hint" instead of leaking a path into a report.
- `provider-diagnostic` keeps its `pass` status when the hint is present, because the diagnostic script itself did run. `src/providers/workbuddy/adapter.ts` adds `details.hostBundleHint: 'not-running'` and appends a sentence to the summary so the reading is not mistaken for "the whole chain works". The hint never overrules `plugin-enabled`: it describes a heartbeat file, not this process.
- Both READMEs now show the current counts: 22 test files, 486 cases.

## Verification

The local Windows audit used Node `v26.9.0`. It ran no model generation and did not change an active DSH profile.

- `tests/providers/workbuddy-package.spec.ts` is new and covers the whole reduction surface: the reason-code closed set, `extractJsonObject` resynchronising after a broken fragment, the field whitelist (paths and PIDs are asserted absent), and the hint collapsing to a fixed token while unrecognised hints are dropped.
- `tests/providers/workbuddy-adapter.spec.ts` gained two cases pinning that the hint produces `pass` plus `details.hostBundleHint` and that an absent hint leaves both alone.
- `pnpm run check` passed both TypeScript checks, all 486 tests in 22 files, and both Host and Client builds.
- The WorkBuddy CLI was run directly against a real 0.1.15 installation to confirm the document shape this patch reads (`signIn`, `hostHeartbeat`, `hints`) is the shape `doctor --json` actually emits, and that `doctor` performs no network call.
- `git diff --check` passed.

These are local automated and packaging checks. They do not establish that the final tarball has been installed in an isolated host, that the Windows Desktop interaction has been accepted, or that other operating systems and DSH versions have been tested for this release. npm publication, the GitHub Release, and market updates require separate verification after they occur.
