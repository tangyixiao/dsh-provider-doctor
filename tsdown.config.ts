/**
 * Two bundles, because the two halves live in different runtimes.
 *
 * The Host half is ESM for Node inside the Electron main process; everything the
 * harness provides (`@deepseek-ai/*`, `schemastery`, `cordis`) is left external
 * so the plugin cannot ship a second copy of a service it is supposed to share.
 *
 * The browser half is a CommonJS factory wrapped in the harness module-loader
 * envelope, and it must not bundle React: the renderer's own React instance is
 * passed in through `require`. Bundling it would give the panel a private
 * renderer and break hooks.
 *
 * @module dsh-provider-doctor/tsdown.config
 */

import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  engines?: { dsh?: string }
}

/**
 * Where build-time constants come from; one source of truth is the manifest.
 *
 * The DSH range is inlined from `engines.dsh` so the host-runtime check holds
 * the running build to exactly the range the plugin manager enforces at install
 * time, with no second copy of the string to drift.
 */
const define = {
  __PROVIDER_DOCTOR_VERSION__: JSON.stringify(manifest.version),
  __PROVIDER_DOCTOR_DSH_RANGE__: JSON.stringify(manifest.engines?.dsh ?? '*'),
}

/** Modules the Host runtime already provides. */
const hostExternals = [
  /^@deepseek-ai\//,
  /^schemastery$/,
  /^cordis$/,
]

/** Modules the renderer already provides, and must not receive a copy of. */
const clientExternals = [
  /^react$/,
  /^react\//,
  /^react-dom$/,
  /^react-dom\//,
  /^@deepseek-ai\//,
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    sourcemap: false,
    fixedExtension: false,
    define,
    deps: { neverBundle: hostExternals },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    clean: false,
    sourcemap: false,
    fixedExtension: false,
    tsconfig: 'tsconfig.client.json',
    define,
    deps: { neverBundle: clientExternals },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
