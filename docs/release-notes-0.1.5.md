# 0.1.5 release notes

Behaviour fix. An offline run could start a process, which is exactly what the basic check promises it never does.

## Changes

- **ZCode's model catalog is no longer read on an offline run.** `llm.listModels()` is not an in-process read for this provider: the bridge answers it from `readCatalog()`, which calls `ensureStarted()`, opens a probe session with `session/create`, closes the session, and leaves the resident `app-server` running. `modelCatalogCheck` now takes a `requested` flag and, when the user did not ask for a side effect, returns `not_checked` with reason `not_requested` and the sentence "Reading the catalog of `<id>` would start its own client, so the doctor did not read it on an offline run." A connection check still reads it — that run already starts the CLI, so the user has accepted a process there.
- Neither README overstates what a basic run does any more: the check table now separates WorkBuddy (read-only) from ZCode (skipped offline, with the reason), and the connection-check section says ZCode's app-server start is the price of reading the catalog rather than an extra probe.

## Verification

Found by auditing child processes rather than by reading the report, on Windows with Node v26.9.0 against DSH 0.2.2-rc.1 in an isolated profile:

- After an offline `POST /plugins/dsh-provider-doctor/diagnose`, `Get-CimInstance Win32_Process` listed `node ...\zcode-app-cli\vendor\zcode.cjs app-server --surface terminal --no-color` with `ParentProcessId` equal to the host process. The same query after the fix lists no such child.
- New `tests/providers/zcode-diagnose.spec.ts` (12 cases) covers `diagnose()` on both paths — the adapter previously had no direct coverage of it. It uses a real child process with a tripwire file instead of a stub, so it asserts the *outcome*: the offline path leaves the tripwire untouched, never calls `listModels`, and reports `not_checked`/`not_requested` for the catalog, credential, and diagnostic checks; the connection path launches the CLI exactly once, calls `listModels` once, and keeps the CLI path out of the diagnostic details.
- Reverting the new gate fails exactly two of those assertions ("never asks the host for a catalog that would spawn the resident client" and "says why the catalog was not read"), which is what makes the test a guard rather than decoration.
- `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` both exit 0. `npx vitest run` is 23 files / 498 cases green. `npm run check` passes.

These are local automated checks. They do not establish that the 0.1.5 tarball has been installed in an isolated host, that the Windows Desktop interaction has been accepted, or that other operating systems and DSH versions have been tested for this release. npm publication, the GitHub Release, and market updates require separate verification after they occur.
