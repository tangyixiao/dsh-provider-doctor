# 0.1.4 release notes

Documentation-only release. No behaviour changed: the diagnostic chain, the reason vocabulary, the owner-only routes, and the prohibited-command fence are byte-for-byte the same as 0.1.3.

## Changes

- Both READMEs now explain why `dsh plugin add dsh-provider-doctor` can land on the previous version right after a release. pnpm 11 enables `minimumReleaseAge` by default (1440 minutes), so a version younger than 24 hours is not selected by `add <name>`, `@latest`, or `@*` — the install quietly resolves the last mature version and prints a `(0.1.3 is available)` style note. The docs show the two ways out: pin the exact version, or pass `--config.minimum-release-age=0` for that one command (`dsh plugin add` forwards it to pnpm), and say plainly that disabling the policy is the reader's own trade-off.

## Verification

Found and measured on Windows with Node v26.9.0 and pnpm 11.0.9, against the published package:

- Resolution matrix in throwaway directories, each with a fresh `package.json`: bare name, `@latest`, `@*`, and `--registry https://registry.npmjs.org/` all resolved `0.1.2` while `dist-tags.latest` was `0.1.3`. `--config.minimum-release-age=0` resolved `0.1.3`, and so did the camelCase spelling.
- Threshold bracketing at 2026-11-09T11:05Z (0.1.3 published 2026-11-08T14:15Z, ~20.8 h earlier): `1000`, `1200`, and `1240` minutes resolved `0.1.3`; `1260` minutes fell back to `0.1.2`. That places the effective default in the 1240–1260 minute band, i.e. 1440 minutes / 24 hours.
- Pinning bypasses it: `dsh-provider-doctor@0.1.3` and `@^0.1.3` both installed `0.1.3`.
- `dsh plugin --profile <name> add dsh-provider-doctor --config.minimum-release-age=0` on an isolated DSH home installed `^0.1.3`, confirming the flag reaches pnpm through the host CLI.
- Both READMEs edited without touching behaviour; line endings preserved (CRLF).

These are local measurement and documentation checks. They do not establish that the 0.1.4 tarball has been installed in an isolated host, that the Windows Desktop interaction has been accepted, or that other operating systems and DSH versions have been tested for this release. npm publication, the GitHub Release, and market updates require separate verification after they occur.
