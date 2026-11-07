# Architecture

This document explains how the pieces fit and, more importantly, **why** each boundary sits where it does. The public contract lives in `src/shared/contract.ts`; everything here is about the shape around it.

## The two halves

The plugin ships two entry points that never call each other directly.

| Entry | Format | Runs in | Job |
|---|---|---|---|
| `lib/index.js` | ESM, Node | the Cordis host process | collect evidence, own the routes |
| `lib/client.js` | CJS wrapped in `window.__ModuleLoader__.load` | the web UI | render the panel, call the routes |

They share exactly one thing: `src/shared/`. That directory holds types and pure functions only — no `node:` imports, no `document`, no `fetch`. The Client half imports `snapshot.ts` for `verdictOf`/`worstStatus` and `contract.ts` for the shape of a report; the Host half imports the same files. If a shared file ever needed `node:fs`, it would be in the wrong directory.

The build enforces this split: `tsconfig.json` excludes `src/client` and `tsconfig.client.json` excludes everything else. A DOM type leaking into shared code fails the Host typecheck.

## Evidence, and who is allowed to produce it

Every `CheckResult` carries a `source` from a closed set. That field is not decoration — it tells the reader how much to trust the line.

| Source | Meaning | Produced by |
|---|---|---|
| `live_host` | read from a running host service in this process | `dsh-llm`, `pluginInventory`, the Cordis loader |
| `provider_diagnostic` | the plugin's own doctor command said so | the child process we spawn |
| `local_metadata` | read from a file on this machine | profile manifests, probe stores |
| `user_supplied` | reserved for input the user typed | (unused in v1) |
| `fallback` | a default, used only when nothing better exists | build-time `engines.dsh` |

The reason for the vocabulary is that these differ in freshness and in failure mode. A `live_host` reading is true of this process right now. A `local_metadata` reading is true of a file at some past moment, and the file may describe a state that has since changed. A `fallback` says nothing about the world at all.

`evidenceKind` cuts the same way: `observed` (we saw it), `inferred` (we reasoned from something we saw), `unavailable` (we could not see it). A check that could not gather evidence is `unknown` or `not_checked` — never `pass`.

## Why ten checks in a fixed order

The chain is `host-runtime → profile-identity → plugin-installed → plugin-enabled → provider-registered → provider-configurable → credential-metadata → model-catalog → provider-diagnostic → recent-error`.

That order is the order in which a fault propagates. If the host version is wrong, nothing downstream is trustworthy; if the plugin is not loaded, its provider cannot be registered; if the provider is not registered, the catalog will be empty no matter what the account looks like. `CHAIN_ORDER` in `src/shared/catalog.ts` is the single source of truth, and `orderChecks` in `src/host/run.ts` sorts every adapter's output through it, so a UI bug cannot present the chain out of order.

The first two links are host facts, identical for every provider. `runDiagnostics` computes them once per run and prepends the same two results to every report, rather than letting each adapter recompute them — otherwise two providers could disagree about the same host build.

## Offline by default, and what that costs

`CHECK_CATALOG` marks two checks `side_effecting`: `credential-metadata` and `provider-diagnostic`. Both are reachable only through the plugin's own CLI, and both therefore require starting a process.

The default run never starts a process. Both checks come back `not_checked` with `reasonCode: 'not_requested'` and `cost: 'side_effecting'`, and the UI shows "starts a process" next to them. The connection check flips them on.

This is a deliberate trade: the credential answer is the one users most want, and it is exactly the one that cannot be read safely from disk. Reading a credential file would mean the diagnostic tool itself handles secrets; asking the plugin that already owns them to describe them does not.

### The hard stop on quota-spending commands

`src/providers/process.ts` holds `PROHIBITED_COMMANDS = new Set(['turn', 'image'])` and throws before spawning anything if the subcommand matches. This is an allowlist-by-exclusion at the lowest layer, not a convention in the adapter, because the adapters are the part most likely to grow a new call site.

## Subprocess policy

`runPluginCli` runs `process.execPath` with an argument array and `shell: false`. No string is ever interpolated into a command line, so a path containing a space, a quote, or a semicolon is just a path.

The interpreter is `process.execPath` and not `node` from `PATH`: the host already has a working Node, and resolving a different one from `PATH` would silently diagnose a different runtime than the one in use.

Abort handling sends `SIGKILL` rather than the default `SIGTERM`, because the native CLIs this plugin talks to do not reliably handle `SIGTERM`. The comment in `process.ts` spells out the Windows limitation honestly: killing a process does not reap its descendants, and the alternatives (`taskkill /T`) require shelling out to an external command on a Windows-only path with a PID-reuse race. The plugin does not pretend otherwise; it just does not leak the direct child.

`parseJsonFromOutput` scans for a balanced brace region rather than calling `JSON.parse` on the whole stdout. Both CLIs print human-readable lines before their JSON, and ZCode exits non-zero *after* printing a valid summary — so a non-zero exit is not treated as "no output".

## The host half

```
index.ts            cordis plugin: builds the service, registers routes
  host/runtime.ts   host facts (version, node, platform, dshHome) + profile discovery
  host/inventory.ts plugin inventory snapshot, normalised; no guessing
  host/host-checks.ts  host-runtime, profile-identity, plugin-installed, plugin-enabled
  host/engine-range.ts the build's own engines.dsh, for the compatibility check
  host/run.ts       runs adapters concurrently, applies budgets, orders checks
  host/service.ts   single-flight, cancellation, kept snapshot, shareable report
  host/routes.ts    five exact routes under /plugins/dsh-provider-doctor
  host/host-auth.ts loopback gates + owner admission
  host/loopback.ts  Host/Origin parsing
```

### Concurrency and budgets

`runDiagnostics` runs every adapter at once. Each adapter is wrapped in `probeWithBudget`, which races the work against a timer and against the caller's abort signal, and settles exactly once. A late result cannot overwrite a timeout, and an abort settles immediately — a hung child process does not keep the run open for its full budget.

When an adapter exceeds its budget, the runner synthesises one `timeout` result per check the adapter *declared* it would produce, so the chain still has the right number of links. When an adapter throws, it synthesises a single `provider-diagnostic` failure rather than dropping the provider silently.

### Single flight, real cancellation

`service.diagnose()` reuses an in-flight promise, so hammering the button does not start five runs. Cancellation goes through an `AbortController` that is threaded all the way into `runDiagnostics` and from there into each adapter and each child process. This was a genuine bug in an earlier draft — the controller was created and aborted but never passed to the runner — and `tests/host/service.spec.ts` now pins the behaviour.

### Routes and authentication

Five exact routes:

```
GET|HEAD /plugins/dsh-provider-doctor/status
POST     /plugins/dsh-provider-doctor/diagnose
POST     /plugins/dsh-provider-doctor/connect
POST     /plugins/dsh-provider-doctor/cancel
GET|HEAD /plugins/dsh-provider-doctor/share
```

`dsh-host-webserver` deliberately has **no server-wide authentication or origin policy** — route owners enforce their own. So `withOwnerAuth` applies three gates, in order:

1. `Host` header must be a loopback name;
2. `Origin`, when present, must be loopback (`null` is rejected);
3. `connection.admit(req)` must succeed and the principal must be `kind: 'owner'`.

A missing `connection` service yields 401, not 200. Every response carries `Cache-Control: no-store`, because a report is a snapshot of this machine and caching it would be a privacy leak across sessions.

Method checks live in each route rather than in the shared gate, so each route can answer `405` with a correct `Allow` header.

## The client half

```
index.tsx       apply(): locale, styles, three slot registrations, cleanup
Panel.tsx       the panel: actions, error/empty/running states, summary
ChainList.tsx   one card per provider, in contract order
CheckRow.tsx    one link: status, cost, evidence, expandable details
HostFacts.tsx   host and profile facts; paths collapsed by default
SharePanel.tsx  render the redacted document, then copy it
store.ts        the panel's state machine
api.ts          fetch wrappers, report formatting, clipboard
locales.ts      zh is the source of truth; en must cover every key
styles.ts       one <style> element, host theme variables only
```

The panel is mounted twice: once as the sidebar's `main` entry, once as the bundle configuration page in the plugin manager. Both render the same `Panel`, so there is no second implementation to drift.

### Registering into the host UI

Three slots are registered, each behind `guardContribution`, so one failing slot logs and degrades instead of taking down the whole client loader:

- `main` (keyed, key = `PANEL_ID`) — the panel body;
- `sidebar.panellist` (list, id = `PANEL_ID`, order 6) — the stethoscope icon;
- `plugins.bundle.config` (keyed, key = the package name) — the plugin manager page.

Teardown checks `layout.panelInfo.getSnapshot().activePanelId` before calling `selectPanel(null)`: selecting a panel id that is no longer registered throws, and the host would be left pointing at a dead key.

### State machine

`Phase` is `idle | running | ready | failed`. `begin()` aborts any previous controller and emits `running` while **keeping** the previous snapshot — an earlier draft dropped it, which meant a refresh blanked the panel and a cancellation had nothing to fall back to. Failures preserve the last good snapshot too, so a transient network error does not erase the evidence you were reading.

Results are discarded when their signal has been aborted, so a slow first request cannot overwrite a newer answer.

### Localisation

`locales.ts` defines `zh` with `as const` and types `en` as `Record<keyof typeof zh, string>`. Adding a key to Chinese without adding it to English is a compile error. Two tests go further: they compare key sets and the set of `{placeholder}` names in each string, because a dictionary can be complete and still interpolate the wrong thing.

Seven strings are deliberately identical across locales — file names, platform names, provider names. Those are the ones a reader will search for.

## Redaction

`src/privacy/redact.ts` is the only place that decides what may leave the machine.

- `redactText` strips JWTs, `sk-`/`sk_`-style keys, bearer tokens, `name=value` pairs whose name looks secret, query values, Windows and POSIX paths, home-relative paths, emails, and long opaque tokens; it truncates beyond 400 characters.
- `redactValue` applies that recursively, to a bounded depth.
- `toShareableReport` does not redact a report — it **rebuilds** one from a whitelist, so a field added to the internal contract later cannot leak by default. Only reason codes present in `REASON_CODES` survive.

The API-key pattern matches both `_` and `-` separators. An earlier version matched only the underscore form, which meant the most common real-world key shape passed through untouched; `tests/privacy/redact.spec.ts` now pins both.

The browser side formats the document with the same whitelist and a test asserts the output is byte-identical to the Host's. That removes the class of bug where a preview looks safe and the copied text is not.

## What is intentionally absent

- No repair action. The plugin does not reinstall, re-enable, re-authenticate, or rewrite a profile.
- No live inference test. That would spend quota, and the answer would still be about the account rather than the wiring.
- No `llm.discoverModels`. It may go to the network with a live credential.
- No credential file reading. See above.
- No `compatibility.json` writes. The exemption mechanism exists in the host; this plugin only reports that versions disagree.
- No host `baseDir` assumption. Cordis `Context` does not expose one, so the profile is discovered from `DSH_HOME` and the profiles directory.
