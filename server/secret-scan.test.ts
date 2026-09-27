import { describe, expect, it } from 'vitest'
import { findSecrets, redactSecrets, ROTATE_HINT } from './secret-scan.ts'

const TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const OTHER = `sk-ant-api03-${'x'.repeat(24)}`

describe('findSecrets', () => {
  it('finds the token value and any sk-ant- key', () => {
    expect(findSecrets(`the token is ${TOKEN}.`, TOKEN)).toEqual(['the OAuth token', 'an sk-ant- key'])
    expect(findSecrets(`leaked ${OTHER}`, TOKEN)).toEqual(['an sk-ant- key'])
    expect(findSecrets('clean text', TOKEN)).toEqual([])
  })

  it('finds a token that is not sk-ant- shaped, and ignores short sk-ant- fragments', () => {
    expect(findSecrets('x plain-token-value-123 y', 'plain-token-value-123')).toEqual(['the OAuth token'])
    expect(findSecrets('see sk-ant-short', null)).toEqual([])
  })

  it('never treats an empty or missing token as found', () => {
    expect(findSecrets('anything', '')).toEqual([])
    expect(findSecrets('anything', null)).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('replaces every occurrence of the token and of sk-ant- keys', () => {
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN} c ${OTHER}`, TOKEN)).toBe('a [REDACTED] b [REDACTED] c [REDACTED]')
    expect(redactSecrets('clean', TOKEN)).toBe('clean')
  })

  it('tells the owner how to rotate', () => {
    expect(ROTATE_HINT).toContain('claude setup-token')
  })
})
