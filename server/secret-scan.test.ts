import { describe, expect, it } from 'vitest'
import { findSecrets, findSecretsInLine, redactSecrets, ROTATE_HINT, SecretHoldback } from './secret-scan.ts'

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

// A structured reply streams as many small fragments; no single fragment need contain the whole
// secret, but their reassembly can (review finding 1, round 2).
describe('SecretHoldback', () => {
  it('never emits a partial prefix of a token still arriving in small chunks, and detects it once fully arrived', () => {
    const holdback = new SecretHoldback(TOKEN)
    let out = ''
    for (const chunk of TOKEN.match(/.{1,5}/g) ?? []) out += holdback.push(chunk)
    expect(out).toBe('') // the whole token is still inside the trailing 256-char holdback window
    expect(holdback.sawSecret).toBe(true) // detection runs on the whole reassembled buffer
    out += holdback.push('after')
    expect(out).toBe('')
    expect(out).not.toContain(TOKEN.slice(0, 8))
  })

  it('emits older text progressively once enough has arrived, always already redacted', () => {
    const holdback = new SecretHoldback(TOKEN)
    let out = holdback.push(`before ${TOKEN} `)
    expect(out).toBe('') // everything so far is still within the holdback window
    out += holdback.push('x'.repeat(300)) // pushes the token's position well past the window
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(TOKEN.slice(0, 8))
    expect(out).toContain('before [REDACTED] ')
    out += holdback.flush()
    expect(out).toBe(`before [REDACTED] ${'x'.repeat(300)}`)
    expect(holdback.sawSecret).toBe(true)
  })

  it('flush releases whatever is still held back, redacted', () => {
    const holdback = new SecretHoldback(TOKEN)
    holdback.push(`short and ${TOKEN}`)
    expect(holdback.flush()).toBe('short and [REDACTED]')
  })

  it('lets clean text through once past the window and never reports a secret', () => {
    const holdback = new SecretHoldback(TOKEN)
    const text = 'x'.repeat(300)
    const emitted = holdback.push(text) + holdback.flush()
    expect(emitted).toBe(text)
    expect(holdback.sawSecret).toBe(false)
  })
})

// Review round 3, minor: a \u-escaped secret decodes to its literal form only once JSON.parse runs.
describe('findSecretsInLine', () => {
  it('finds a token hidden behind \\u escapes by scanning decoded JSON string values', () => {
    const escaped = [...TOKEN].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
    const line = `{"answer":"${escaped}"}`
    expect(line).not.toContain(TOKEN) // sanity: the raw bytes never contain the token
    expect(findSecretsInLine(line, TOKEN)).toEqual(expect.arrayContaining(['the OAuth token']))
  })

  it('walks nested objects and arrays', () => {
    const line = JSON.stringify({ decisions: [{ options: [{ consequence: `see ${TOKEN}` }] }] })
    expect(findSecretsInLine(line, TOKEN)).toEqual(expect.arrayContaining(['the OAuth token']))
  })

  it('falls back to a plain scan when the line is not valid JSON', () => {
    expect(findSecretsInLine(`not json but has ${TOKEN} anyway`, TOKEN)).toEqual(expect.arrayContaining(['the OAuth token']))
    expect(findSecretsInLine('not json, clean', TOKEN)).toEqual([])
  })

  it('finds nothing in clean JSON', () => {
    expect(findSecretsInLine(JSON.stringify({ ok: true, numTurns: 2 }), TOKEN)).toEqual([])
  })
})
