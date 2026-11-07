import { describe, expect, it } from 'vitest'

import {
  modelCatalogCheck,
  providerConfigurableCheck,
  providerRegisteredCheck,
} from '../../src/providers/shared-checks.ts'
import type { ConfigurableProviderLike, ConfigurableProviderLike as Entry, LlmLike } from '../../src/providers/types.ts'

/** A minimal `llm` stand-in; every method is overridable per test. */
function fakeLlm(overrides: Partial<LlmLike> = {}): LlmLike {
  return {
    listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }],
    listConfigurableProviders: () => [entry()],
    listModels: async () => [{ id: 'deepseek-v4.1-flash' }],
    ...overrides,
  }
}

/** One configuration-directory row. */
function entry(overrides: Partial<Entry> = {}): ConfigurableProviderLike {
  return { provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', ...overrides }
}

describe('providerRegisteredCheck', () => {
  it('passes when the route table lists the provider', () => {
    const result = providerRegisteredCheck({
      llm: fakeLlm(),
      providerId: 'workbuddy',
      pluginName: 'dsh-workbuddy-connect-community',
    })
    expect(result.id).toBe('provider-registered')
    expect(result.status).toBe('pass')
    expect(result.evidenceKind).toBe('observed')
    expect(result.source).toBe('live_host')
    expect(result.details).toMatchObject({ provider: 'workbuddy', routeCount: 1 })
    expect(result.reasonCode).toBeUndefined()
  })

  it('fails when the route table lacks the provider', () => {
    const result = providerRegisteredCheck({
      llm: fakeLlm({ listProviders: () => [{ id: 'somebody-else', name: 'Other' }] }),
      providerId: 'workbuddy',
      pluginName: 'dsh-workbuddy-connect-community',
    })
    expect(result.status).toBe('fail')
    expect(result.reasonCode).toBe('provider_not_registered')
    expect(result.summary).toContain('workbuddy')
    expect(result.nextSteps.join(' ')).toContain('dsh-workbuddy-connect-community')
  })

  it('is unknown, not failed, when this host has no llm service', () => {
    const result = providerRegisteredCheck({
      llm: undefined,
      providerId: 'zcode-cli',
      pluginName: 'dsh-zcode-plan-bridge',
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('llm_unavailable')
    expect(result.source).toBe('fallback')
    expect(result.evidenceKind).toBe('unavailable')
  })

  it('is unknown, not failed, when listing routes throws', () => {
    const result = providerRegisteredCheck({
      llm: fakeLlm({
        listProviders: () => {
          throw new Error('boom')
        },
      }),
      providerId: 'workbuddy',
      pluginName: 'dsh-workbuddy-connect-community',
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('llm_unavailable')
    expect(result.details).toMatchObject({ error: 'boom' })
  })
})

describe('providerConfigurableCheck', () => {
  it('passes when the provider is in the configuration directory', () => {
    const result = providerConfigurableCheck({ llm: fakeLlm(), providerId: 'workbuddy' })
    expect(result.status).toBe('pass')
    expect(result.details).toMatchObject({ settingsNs: 'workbuddy' })
  })

  it('warns, rather than fails, when only the settings surface is missing', () => {
    const result = providerConfigurableCheck({
      llm: fakeLlm({ listConfigurableProviders: () => [] }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('warning')
    expect(result.reasonCode).toBe('provider_not_configurable')
    expect(result.summary).toContain('cannot be configured')
    expect(result.nextSteps.join(' ')).toContain('requests can still be served')
  })

  it('warns and quotes the reported configuration error', () => {
    const result = providerConfigurableCheck({
      llm: fakeLlm({ listConfigurableProviders: () => [entry({ error: 'missing base URL' })] }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('warning')
    expect(result.details).toMatchObject({ configurationError: 'missing base URL' })
  })

  it('passes when the directory entry carries no error', () => {
    const result = providerConfigurableCheck({
      llm: fakeLlm({ listConfigurableProviders: () => [entry()] }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('pass')
    expect(result.details).not.toHaveProperty('configurationError')
  })

  it('is unknown when the directory cannot be read', () => {
    const result = providerConfigurableCheck({
      llm: fakeLlm({
        listConfigurableProviders: () => {
          throw new Error('nope')
        },
      }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('llm_unavailable')
  })

  it('is unknown when this host has no llm service', () => {
    const result = providerConfigurableCheck({ llm: undefined, providerId: 'workbuddy' })
    expect(result.status).toBe('unknown')
    expect(result.source).toBe('fallback')
  })
})

describe('modelCatalogCheck', () => {
  it('passes with a count and a bounded sample', async () => {
    const models = Array.from({ length: 20 }, (_unused, index) => ({
      id: `model-${index}`,
      contextWindow: 128_000,
    }))
    const result = await modelCatalogCheck({
      llm: fakeLlm({ listModels: async () => models }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('pass')
    expect(result.details).toMatchObject({ modelCount: 20, firstContextWindow: 128_000 })
    expect((result.details?.['sample'] as string[]).length).toBe(8)
  })

  it('fails when the catalog is empty, because no request can be sent', async () => {
    const result = await modelCatalogCheck({
      llm: fakeLlm({ listModels: async () => [] }),
      providerId: 'zcode-cli',
    })
    expect(result.status).toBe('fail')
    expect(result.reasonCode).toBe('catalog_empty')
    expect(result.details).toMatchObject({ modelCount: 0 })
  })

  it('is unknown when the adapter rejects the catalog request', async () => {
    const result = await modelCatalogCheck({
      llm: fakeLlm({
        listModels: async () => {
          throw new Error('adapter exploded')
        },
      }),
      providerId: 'workbuddy',
    })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('catalog_unreadable')
    expect(result.details).toMatchObject({ error: 'adapter exploded' })
  })

  it('is unknown when this host has no llm service', async () => {
    const result = await modelCatalogCheck({ llm: undefined, providerId: 'workbuddy' })
    expect(result.status).toBe('unknown')
    expect(result.reasonCode).toBe('llm_unavailable')
  })

  it('never asks the provider to discover models over the network', async () => {
    const calls: string[] = []
    const llm: LlmLike = {
      listProviders: () => [],
      listConfigurableProviders: () => [],
      listModels: async () => {
        calls.push('listModels')
        return [{ id: 'only' }]
      },
    }
    await modelCatalogCheck({ llm, providerId: 'workbuddy' })
    expect(calls).toEqual(['listModels'])
  })

  it('does not read a catalog when no route adapter exists to read it from', async () => {
    const calls: string[] = []
    const llm: LlmLike = {
      listProviders: () => [],
      listConfigurableProviders: () => [],
      listModels: async () => {
        calls.push('listModels')
        return [{ id: 'only' }]
      },
    }
    const result = await modelCatalogCheck({ llm, providerId: 'workbuddy', registered: false })
    expect(result.status).toBe('not_checked')
    expect(result.reasonCode).toBe('provider_not_registered')
    expect(calls).toEqual([])
  })

  it('reads the catalog when the route is registered', async () => {
    const result = await modelCatalogCheck({
      llm: fakeLlm({ listModels: async () => [{ id: 'only' }] }),
      providerId: 'workbuddy',
      registered: true,
    })
    expect(result.status).toBe('pass')
  })
})
