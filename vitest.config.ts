import { defineConfig } from 'vitest/config'

/**
 * One config for both halves of the plugin.
 *
 * The Host half runs in plain Node: it reads files, spawns children and talks to
 * services. The Client half is a browser module that only touches `fetch`,
 * `document` and `navigator`; those test files opt into jsdom with a
 * `@vitest-environment jsdom` docblock, so this config stays free of a glob
 * matcher.
 *
 * Test files are not parallelised: the Host tests read the real filesystem and
 * the real `process.env`, so two files changing either at once would make a
 * failure depend on scheduling rather than on code.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/support/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
  },
})
