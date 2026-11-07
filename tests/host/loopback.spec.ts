import { describe, expect, it } from 'vitest'

import { hostIsLoopback, hostnameOfHost, originIsLoopback } from '../../src/host/loopback.ts'

describe('hostnameOfHost', () => {
  it('reads a bare hostname', () => {
    expect(hostnameOfHost('localhost')).toBe('localhost')
  })

  it('strips a numeric port', () => {
    expect(hostnameOfHost('127.0.0.1:13639')).toBe('127.0.0.1')
  })

  it('keeps a bracketed IPv6 literal intact', () => {
    expect(hostnameOfHost('[::1]')).toBe('[::1]')
  })

  it('strips the port after a bracketed IPv6 literal', () => {
    expect(hostnameOfHost('[::1]:13639')).toBe('[::1]')
  })

  it('accepts the bare IPv6 loopback without splitting on its colons', () => {
    expect(hostnameOfHost('::1')).toBe('::1')
  })

  it('lowercases the result', () => {
    expect(hostnameOfHost('LOCALHOST:80')).toBe('localhost')
  })

  it('rejects an unparseable port', () => {
    expect(hostnameOfHost('localhost:http')).toBeUndefined()
  })

  it('rejects an empty or missing header', () => {
    expect(hostnameOfHost('')).toBeUndefined()
    expect(hostnameOfHost(undefined)).toBeUndefined()
  })

  it('rejects an unterminated bracket', () => {
    expect(hostnameOfHost('[::1')).toBeUndefined()
  })
})

describe('hostIsLoopback', () => {
  it('accepts every spelling of this machine', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:13639', '[::1]', '[::1]:1', '::1']) {
      expect(hostIsLoopback(host)).toBe(true)
    }
  })

  it('rejects a rebound DNS name, even one that resolves to loopback', () => {
    expect(hostIsLoopback('doctor.example.test')).toBe(false)
    expect(hostIsLoopback('doctor.example.test:13639')).toBe(false)
  })

  it('rejects a LAN address', () => {
    expect(hostIsLoopback('192.168.1.20:13639')).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(hostIsLoopback(undefined)).toBe(false)
  })
})

describe('originIsLoopback', () => {
  it('accepts an absent origin', () => {
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('')).toBe(true)
    expect(originIsLoopback('   ')).toBe(true)
  })

  it('accepts a loopback origin with a port', () => {
    expect(originIsLoopback('http://127.0.0.1:13639')).toBe(true)
    expect(originIsLoopback('http://localhost:13639')).toBe(true)
    expect(originIsLoopback('http://[::1]:13639')).toBe(true)
  })

  it('rejects a public origin', () => {
    expect(originIsLoopback('https://example.test')).toBe(false)
  })

  it('rejects the opaque null origin a sandboxed page sends', () => {
    expect(originIsLoopback('null')).toBe(false)
  })

  it('rejects something that is not a URL at all', () => {
    expect(originIsLoopback('not-a-url')).toBe(false)
  })
})
