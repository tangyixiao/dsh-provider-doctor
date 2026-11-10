<p align="center"><img src="assets/logo.webp" width="192" height="192" alt="DSH Provider Doctor logo"></p>

<h1 align="center">DSH Provider Doctor</h1>

<p align="center">Trace host, installation, registration, credential and catalog evidence to locate a broken DSH model connection.</p>

<p align="center"><a href="https://github.com/tangyixiao/dsh-provider-doctor"><img src="docs/assets/banner-en.svg" width="100%" alt="DSH Provider Doctor — Project and usage guide"></a></p>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

[![Stars](https://img.shields.io/github/stars/tangyixiao/dsh-provider-doctor?style=flat)](https://github.com/tangyixiao/dsh-provider-doctor/stargazers) [![CI](https://img.shields.io/github/actions/workflow/status/tangyixiao/dsh-provider-doctor/check.yml?branch=main)](https://github.com/tangyixiao/dsh-provider-doctor/actions/workflows/check.yml) [![License](https://img.shields.io/github/license/tangyixiao/dsh-provider-doctor)](LICENSE) [![npm](https://img.shields.io/npm/v/dsh-provider-doctor)](https://www.npmjs.com/package/dsh-provider-doctor)

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-1-en-dark.svg"><img src="docs/assets/feature-1-en-light.svg" width="260" alt="Evidence per link: Ten checks with explicit evidence sources"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-2-en-dark.svg"><img src="docs/assets/feature-2-en-light.svg" width="260" alt="Explicit connection checks: Basic checks start no child process"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-3-en-dark.svg"><img src="docs/assets/feature-3-en-light.svg" width="260" alt="Redacted reports: Allowlisted fields without account secrets"></picture>
</p>

## Get started

Desktop: install the release `.tgz` through Extensions → Plugin Management → Add Plugin. For a Web profile you explicitly control:

```sh
dsh plugin --profile web add dsh-provider-doctor@0.1.8
```

Open Provider Doctor in the sidebar and start with the basic check. A connection check explicitly runs provider diagnostics; reading a ZCode catalog may start its app-server.

## Status and compatibility

| Item | Current source of truth |
| --- | --- |
| Source version | `0.1.8` · 以 [package.json](package.json) 为准 |
| Distribution | `npm` · [Releases](https://github.com/tangyixiao/dsh-provider-doctor/releases) |
| DSH | `0.2.2-rc.1` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Development | [Open issues](https://github.com/tangyixiao/dsh-provider-doctor/issues?q=is%3Aissue+is%3Aopen) · [CI](https://github.com/tangyixiao/dsh-provider-doctor/actions) |

The plugin diagnoses; it does not repair settings, sign you in or send quota-consuming model requests. Treat not checked as missing evidence.

[Detailed usage, configuration and troubleshooting](docs/guide.en.md)

## Development and participation

```sh
pnpm install --frozen-lockfile
pnpm run check
node tools/check-repository.mjs
```

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Questions](https://github.com/tangyixiao/dsh-provider-doctor/discussions) · [Report a bug](https://github.com/tangyixiao/dsh-provider-doctor/issues/new/choose) · [Security](SECURITY.md) · [Maintenance](docs/maintenance.md)

## Star History

<picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tangyixiao/dsh-provider-doctor&amp;type=date&amp;theme=dark&amp;legend=top-left"><img src="https://api.star-history.com/chart?repos=tangyixiao/dsh-provider-doctor&amp;type=date&amp;legend=top-left" width="900" alt="DSH Provider Doctor Star History"></picture>

[Interactive chart](https://www.star-history.com/?repos=tangyixiao%2Fdsh-provider-doctor&type=date) · [GitHub Stars](https://github.com/tangyixiao/dsh-provider-doctor/stargazers)

The external chart uses real star records and may be cached or unavailable; no development percentage is inferred.

## Origin and licenses

[Software license](LICENSE) · [Logo artwork and attribution](assets/NOTICE.md)

Software retains its existing license. Whale-girl derivative artwork is separately CC BY-NC-SA 4.0 with the attribution chain for 上善, ZipZipPipe and Small-tailqwq.
