// Reads the top-level "answer" string out of a JSON object that arrives in arbitrary chunks (the
// StructuredOutput tool's input_json_delta stream) and returns its decoded text as it grows.
// Everything else in the object (other keys, nested objects, strings containing "answer") is skipped.
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }
const WHITESPACE = new Set([' ', '\n', '\r', '\t'])
type Mode = 'scan' | 'key' | 'skip' | 'answer' | 'done'

export class AnswerReader {
  #mode: Mode = 'scan'
  #depth = 0
  #expectKey = false
  #key = ''
  #lastKey: string | null = null
  #awaitValue = false
  #escape = false
  #hex: string | null = null
  #high: string | null = null
  #text = ''

  get text(): string {
    return this.#text
  }

  get done(): boolean {
    return this.#mode === 'done'
  }

  push(chunk: string): string {
    let out = ''
    for (const ch of chunk) {
      if (this.#mode === 'done') break
      out += this.#step(ch)
    }
    this.#text += out
    return out
  }

  #step(ch: string): string {
    if (this.#mode === 'answer') return this.#answer(ch)
    if (this.#mode === 'key' || this.#mode === 'skip') this.#string(ch)
    else this.#scan(ch)
    return ''
  }

  #scan(ch: string): void {
    if (WHITESPACE.has(ch)) return
    if (this.#awaitValue) {
      this.#awaitValue = false
      if (ch === '"') {
        this.#mode = 'answer'
        return
      }
    }
    if (ch === '"') {
      this.#mode = this.#depth === 1 && this.#expectKey ? 'key' : 'skip'
      this.#key = ''
      return
    }
    if (ch === '{' || ch === '[') {
      this.#depth += 1
      if (this.#depth === 1) this.#expectKey = ch === '{'
      return
    }
    if (ch === '}' || ch === ']') {
      this.#depth -= 1
      return
    }
    if (this.#depth !== 1) return
    if (ch === ',') {
      this.#expectKey = true
      this.#lastKey = null
    } else if (ch === ':') {
      this.#awaitValue = this.#lastKey === 'answer'
    }
  }

  #string(ch: string): void {
    const key = this.#mode === 'key'
    if (this.#escape) {
      this.#escape = false
      if (key) this.#key += ch
      return
    }
    if (ch === '\\') {
      this.#escape = true
      return
    }
    if (ch === '"') {
      if (key) {
        this.#lastKey = this.#key
        this.#expectKey = false
      }
      this.#mode = 'scan'
      return
    }
    if (key) this.#key += ch
  }

  #answer(ch: string): string {
    if (this.#hex !== null) {
      this.#hex += ch
      if (this.#hex.length < 4) return ''
      const code = Number.parseInt(this.#hex, 16)
      this.#hex = null
      return Number.isNaN(code) ? '' : this.#emit(String.fromCharCode(code))
    }
    if (this.#escape) {
      this.#escape = false
      if (ch === 'u') {
        this.#hex = ''
        return ''
      }
      return this.#emit(ESCAPES[ch] ?? ch)
    }
    if (ch === '\\') {
      this.#escape = true
      return ''
    }
    if (ch === '"') {
      this.#mode = 'done'
      const held = this.#high ?? ''
      this.#high = null
      return held
    }
    return this.#emit(ch)
  }

  // Holds a high surrogate until its low half arrives, so no emitted piece is ever half a pair.
  #emit(unit: string): string {
    const code = unit.length === 1 ? unit.charCodeAt(0) : -1
    const held = this.#high ?? ''
    if (code >= 0xd800 && code <= 0xdbff) {
      this.#high = unit
      return held
    }
    this.#high = null
    return held + unit
  }
}
