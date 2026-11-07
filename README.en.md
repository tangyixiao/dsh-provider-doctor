# DSH Provider Doctor

A read-only connection diagnostician. When a model provider in DeepSeek Harness (WorkBuddy, WorkBuddy AI, ZCode CLI) stops working, it walks a fixed chain and tells you **which link is broken** and **what to do next**.

It will not fix anything. It will not sign you in again, reinstall a plugin, or rewrite a setting. It only makes the failure legible.

## The problem it solves

When a model fails, the symptom is always the same: nothing comes back. The cause can be anywhere:

- The host version does not satisfy the plugin's `engines.dsh`.
- The plugin is installed but disabled, or it failed while loading.
- The provider was never registered on the LLM route (even though the plugin is `active`).
- The provider is registered but has no configuration directory entry, so it never appears in settings.
- The credential is missing, unreadable, or from another region.
- The model catalog cannot be read, or it reads back empty.
- The last request was actually rejected by the model, and nobody wrote down why.

Each of these has a different evidence source: the first few need host services, the middle ones need the plugin's own diagnostic command, the last one can only be read from a local record. Guessing across all of them tends to produce useless conclusions like "probably the network".

Provider Doctor instead reports **one conclusion per link**, each labelled with where the evidence came from, whether it was observed or inferred, and when it was taken. A link with no evidence says "not checked" — it is never counted as passing.

## The chain

Every provider shows ten checks in this order, which is also the direction a fault propagates:

| # | Check | Question | Runs by default |
|---|---|---|---|
| 1 | `host-runtime` | Does the host version satisfy this plugin's `engines.dsh`? | yes (read-only) |
| 2 | `profile-identity` | Which profile is being diagnosed, and is that determinable? | yes (read-only) |
| 3 | `plugin-installed` | Is the plugin present in this profile? | yes (read-only) |
| 4 | `plugin-enabled` | Is it enabled, and did it load? | yes (read-only) |
| 5 | `provider-registered` | Is the provider registered on the LLM route? | yes (read-only) |
| 6 | `provider-configurable` | Does it have an entry in the configuration directory? | yes (read-only) |
| 7 | `credential-metadata` | Can the credential be resolved locally? | **no**, needs a connection check |
| 8 | `model-catalog` | Can the model catalog be read, and is it non-empty? | yes (read-only) |
| 9 | `provider-diagnostic` | What does the plugin's own diagnostic command report? | **no**, needs a connection check |
| 10 | `recent-error` | Is there a record of how the last request ended? | yes (read-only) |

Checks 7 and 9 are labelled "starts a process". Under the default basic check they read "not checked" and say why — they are not painted green.

## Two buttons, two costs

**Basic check** (default)

Read-only. No network, no child process. It reads host service snapshots, the profile's `package.json`, and local diagnostic records. Typically tens of milliseconds.

**Connection check** (you have to ask for it)

Adds two things:

1. It runs the plugin's own diagnostic command — `doctor --json --provider <id>` for WorkBuddy, `doctor --json` for ZCode. Neither sends a model request.
2. That yields the real reading for credential state and model catalog.

It spawns one Node child process, and the button says so. Timeouts, cancellations and killed children are reported as exactly that — **never** as a sign-out.

ZCode's `turn` and `image` subcommands spend Start Plan quota. This plugin blocks them in code; they are unreachable.

## Four kinds of "working", kept apart

This is the easiest thing to conflate, so the panel keeps four independent conclusions:

- **Plugin installed** — the profile declares it, or the host plugin inventory has a row for it.
- **Provider registered** — the LLM route carries this provider. This is the only evidence that explains an empty model picker.
- **Catalog readable** — `listModels()` returned a non-empty array. That says the catalog reads; it does not say the account can be billed.
- **Live inference succeeded** — **this plugin never tests it.** The shareable report pins `liveInference: not-tested`, because testing it means sending a real request and spending real quota.

Likewise, a passing `credential-metadata` means the credential resolves locally. It does **not** mean the token is still valid or unrevoked.

## Privacy

Diagnosis is local. Nothing leaves the machine unless you copy the report.

The redacted report contains only:

- plugin version, runtime version, platform, architecture;
- the four readiness conclusions per provider;
- per check: id, status, evidence kind, source, and a reason code **from the contract's closed vocabulary**.

It does not contain local paths, usernames, account identifiers, environment variables, PIDs, full URLs, tokens, raw stderr, chat content, check summaries, next steps, or raw detail objects.

The shareable text is produced by one whitelist function, and the Host and browser sides are byte-identical — what the preview shows is what the clipboard gets, with no second transformation in between.

Absolute paths in the panel are collapsed by default and require a click to reveal.

## Install

```bash
dsh plugin install dsh-provider-doctor
```

Or add it to a profile's dependencies and restart the host. The plugin inserts one row through `cordis.patch.yml`, with row id `provider-doctor`.

A stethoscope icon appears in the left sidebar; the plugin's bundle page in the plugin manager shows the same panel.

## Compatibility

| Item | Range |
|---|---|
| DSH | `0.2.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |

`engines.dsh` pins one exact version. After a host upgrade that falls outside it, check 1 of the report says the versions do not match — it does not go quiet and it does not pretend to be compatible.

## Development

```bash
pnpm install
pnpm run check        # typecheck + 21 test files / 453 cases + build
pnpm run build        # tsdown: ESM for the Host, CJS + ModuleLoader for the Client
```

Layout:

```
src/
  shared/       contract, reason codes, check catalog, pure snapshot helpers (both halves)
  host/         host runtime, plugin inventory, check implementations, service, routes, auth
  providers/    child-process wrapper, recent-error reader, adapters for both plugins
  privacy/      redaction whitelist
  client/       React panel, sidebar entry, i18n, styles
tests/          21 spec files
docs/           architecture notes
```

Hard rules the implementation holds to:

- **Never invent a version.** If the host version cannot be read, say unknown.
- **Never read a credential file.** Credential state is only observable through the plugin's own CLI.
- **Never call `discoverModels`.** It may go over the network with a live credential.
- **A `pass` never carries a reason code.** A code on a pass sends people hunting a fault that is not there.
- **`not_checked` is not healthy.** Unchecked means unchecked.

## Licence

MIT. The fakes under `tests/support/` are MIT as well.

## See also

- [WorkBuddy Connect](https://github.com/tangyixiao/dsh-workbuddy-connect-community) — provides the `workbuddy` and `workbuddy-ai` providers
- [ZCode Plan Bridge](https://github.com/tangyixiao/dsh-zcode-plan-bridge) — provides `zcode-cli`
