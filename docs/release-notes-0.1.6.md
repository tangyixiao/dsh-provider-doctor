# 0.1.6 release notes

Behaviour fix. A connection check on a cold machine reported a healthy provider as eight timeouts.

## Changes

- **A connection check now gets its own budget.** The per-adapter budget was a flat 8000 ms, sized for the offline path. A connection check starts the provider's own CLI, and on a cold machine that time is dominated by module loading rather than by the work: the ZCode bridge's first run took 8.35 s end-to-end and every one of its eight checks came back `timeout/timed_out`, while the same check run warm took 2.65 s and returned 9 passes. That is honest but useless — it says "I gave up", not "this provider is broken".
  - Offline runs keep 8000 ms / 5000 ms per probe. That path must stay cheap, and it does not start anything.
  - Connection checks now default to 45000 ms per adapter and 30000 ms per probe. An explicit `adapterBudgetMs` / `probeBudgetMs` still wins, and cancellation is unchanged: the budget bounds a run, it does not make one uninterruptible.

## Verification

Measured on Windows with Node v26.9.0 against DSH 0.2.2-rc.1, in an isolated profile with WorkBuddy 0.1.15 and ZCode 0.6.0 installed, using the published 0.1.5 tarball for the "before" numbers:

- Cold first `/connect`: 8353 ms, `zcode-cli` reported `timeout` on all eight checks while WorkBuddy and WorkBuddy AI reported 8 passes each. Second `/connect` on the same host: 2647 ms, `pass=9 timeout=0` for `zcode-cli`.
- The fix is covered by three new cases in `tests/host/run.spec.ts`, which assert the adapter's own budget rather than a comment: 5000 ms on an offline run, 30000 ms when the connection check is requested, and an explicit override still honoured.
- `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` both exit 0. `npx vitest run` is 23 files / 501 cases green.

### After publication

Run against the published 0.1.6 package (not a local tarball) in an isolated DSH home with its own profile, WorkBuddy 0.1.15 and ZCode 0.6.0 installed, DSH 0.2.2-rc.1 on Windows:

- Cold first `/connect`: **6613 ms**, `workbuddy pass=8 timeout=0`, `workbuddy-ai pass=8 timeout=0`, `zcode-cli pass=9 timeout=0`. The 8.35 s / eight-timeouts result no longer reproduces.
- Offline `/diagnose`: 844 ms, three reports, no failures, and **zero `zcode.cjs app-server` child processes before or after** — the offline run stays offline.
- `/share`: `version=0.1.6`, three reports, every readiness field populated; a scan of the document for `C:\Users`, `D:\tmp`, `tangy`, `AppData`, `token`, `pid`, `/profiles/` and `\.zcode` returned zero hits.
- The desktop panel rendered in a browser: sidebar entry present, ten checks per provider with status, cost and evidence labels, the sanitised-report card, no console errors.

What is still not established: the Windows Desktop interaction here was a browser session against an isolated headless host, not the packaged desktop app; and this release has not been exercised on macOS or Linux beyond the CI job that builds and tests it.
