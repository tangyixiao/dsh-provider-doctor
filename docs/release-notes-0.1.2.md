# 0.1.2 release notes

This patch improves WorkBuddy diagnostic evidence and corrects the installation examples. The DSH compatibility declaration remains `0.2.2-rc.1`.

## Changes

- When the WorkBuddy diagnostic CLI exits with a module-resolution error such as `ERR_MODULE_NOT_FOUND`, report `diagnostic_cli_unloadable` and leave credential state unknown. Commit `b6484eb` separates that startup failure from a signed-out account; signing in again cannot repair a CLI that never loaded.
- Treat WorkBuddy's shared host heartbeat as contextual metadata. A stale or absent heartbeat does not establish whether the current host or profile has registered the provider. Registration continues to use the live host's separate check, and the diagnostic no longer recommends reloading DSH solely because a recorded process ended.
- Both READMEs now show `dsh plugin --profile desktop add dsh-provider-doctor` and tell readers to select the actual target profile explicitly.

## Verification

The local Windows audit used Node `v26.9.0`. It ran no model generation and did not change an active DSH profile.

- The heartbeat regression was reproduced before the fix: two cases failed because a stale or missing shared heartbeat produced a `plugin_not_loaded` warning. The same focused test file passed all 29 cases after the fix.
- `pnpm run check` passed both TypeScript checks, all 457 tests in 21 files, and both Host and Client builds.
- `npm pack --dry-run --json` completed with the configured prepack build and listed the package manifest, two READMEs, license, Cordis patch, Host bundle and declaration, and Client bundle.
- `git diff --check` passed.

These are local automated and packaging checks. They do not establish that the final tarball has been installed in an isolated host, that the Windows Desktop interaction has been accepted, or that other operating systems and DSH versions have been tested for this release. npm publication, the GitHub Release, and market updates require separate verification after they occur.
