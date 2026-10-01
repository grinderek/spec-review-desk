// Spec B §5.2: the API key lives in the Codex process environment inside the container, so
// every reply, streamed text, log and output file of a run is scanned for it before anything is
// moved, committed or shown.
const SK_ANT = /sk-ant-[A-Za-z0-9_-]{20,}/g
const SK_OPENAI = /sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g
// Also mask JWT prefixes cut off mid-stream; credentials never reach scoped file tools.
const JWT = /eyJ[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]+){0,2}/g
const KEYS = new RegExp(`${SK_ANT.source}|${SK_OPENAI.source}|${JWT.source}`, 'g')

export const ROTATE_HINT =
  'A secret appeared in the agent output. Nothing was moved or committed and the log was redacted. For ChatGPT run npm run agent:logout and npm run agent:login; for API mode rotate the key and update OPENAI_API_KEY in .env.'

export function findSecrets(text: string, token: string | null): string[] {
  return [
    ...(token && text.includes(token) ? ['the OAuth token'] : []),
    ...(new RegExp(SK_ANT.source).test(text) ? ['an sk-ant- key'] : []),
    ...(new RegExp(SK_OPENAI.source).test(text) ? ['an OpenAI API key'] : []),
    ...(new RegExp(JWT.source).test(text) ? ['a JWT credential'] : []),
  ]
}

// Spec B §5.2 covers the token "or any >= 8-char piece of it" (review round 4): every string that
// is persisted, published or recorded masks each such piece, every full sk-ant- key and, in a
// finished text, a trailing partial sk-ant- key cut off mid-stream.
const MIN_PIECE = 8
const MASK = '[REDACTED]'
// The shape prefix every OAuth token shares ("sk-ant-oat01-"): masked like any piece, but a piece
// lying wholly inside it reveals nothing, so it does not count as the run having seen a secret.
const PUBLIC_PREFIX = /^sk-(?:ant-(?:[a-z]+\d*-)?|proj-|svcacct-)?/
const PARTIAL_KEY_AT_END = /sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]*$/
interface Range { start: number; end: number; secret: boolean }

function publicPart(text: string): string {
  return PUBLIC_PREFIX.exec(text)?.[0] ?? ''
}

// Leftmost-longest pieces of the token (>= 8 characters, or the whole token when it is shorter).
function tokenRanges(text: string, token: string): Range[] {
  const min = Math.min(MIN_PIECE, token.length)
  const grams = new Set(Array.from({ length: token.length - min + 1 }, (_, i) => token.slice(i, i + min)))
  const open = publicPart(token)
  const ranges: Range[] = []
  for (let i = 0; i + min <= text.length; ) {
    const gram = text.slice(i, i + min)
    if (!grams.has(gram)) {
      i += 1
      continue
    }
    let best = min
    for (let k = token.indexOf(gram); k !== -1; k = token.indexOf(gram, k + 1)) {
      let length = min
      while (i + length < text.length && k + length < token.length && text[i + length] === token[k + length]) length += 1
      best = Math.max(best, length)
    }
    ranges.push({ start: i, end: i + best, secret: !open.includes(text.slice(i, i + best)) })
    i += best
  }
  return ranges
}

function secretRanges(text: string, token: string | null, final: boolean): Range[] {
  const found: Range[] = [
    ...(token ? tokenRanges(text, token) : []),
    ...[...text.matchAll(KEYS)].map((m) => ({ start: m.index, end: m.index + m[0].length, secret: true })),
  ]
  const partial = final ? PARTIAL_KEY_AT_END.exec(text) : null
  if (partial) found.push({ start: partial.index, end: text.length, secret: partial[0].length > publicPart(partial[0]).length })
  const merged: Range[] = []
  for (const range of found.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && range.start < last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end), secret: last.secret || range.secret }
    } else {
      merged.push(range)
    }
  }
  return merged
}

function applyMask(text: string, ranges: Range[]): { text: string; secret: boolean } {
  let out = ''
  let at = 0
  for (const range of ranges) {
    out += text.slice(at, range.start) + MASK
    at = range.end
  }
  return { text: out + text.slice(at), secret: ranges.some((r) => r.secret) }
}

// Masks a finished string; `secret` is true when a piece beyond the public prefix was masked.
export function maskSecrets(text: string, token: string | null): { text: string; secret: boolean } {
  return applyMask(text, secretRanges(text, token, true))
}

export function redactSecrets(text: string, token: string | null): string {
  return maskSecrets(text, token).text
}

// Masks every string value of a persisted or published object (review round 4, finding 1).
export function maskDeep<T>(value: T, token: string | null): { value: T; secret: boolean } {
  let secret = false
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const masked = maskSecrets(item, token)
      secret ||= masked.secret
      return masked.text
    }
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    return item
  }
  const masked = walk(value) as T
  return { value: masked, secret }
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into)
  else if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, into)
}

// A \u-escaped secret decodes to its literal form once JSON.parse runs; a plain substring/regex
// scan of the raw bytes would miss it (review round 3, minor). Parse the line and scan every
// decoded string value instead of the raw text; falls back to a plain scan when the line is not
// valid JSON (e.g. plain narration text, already decoded by the time it reaches this function).
export function findSecretsInLine(line: string, token: string | null): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return findSecrets(line, token)
  }
  const strings: string[] = []
  collectStrings(parsed, strings)
  const found = new Set<string>()
  for (const value of strings) for (const reason of findSecrets(value, token)) found.add(reason)
  return [...found]
}

// A structured reply streams as many small fragments (the CLI's input_json_delta chunking); no
// single fragment need contain the whole token, but their reassembly (the reconstructed narration
// or answer text) can. Buffer the reconstructed text per channel and release only the part old
// enough that any secret piece starting in it has fully arrived, masked; a release never cuts a
// masked piece in two. flush() masks the rest as a finished text, so a stop or timeout mid-token
// masks the partial prefix it cut off and reports it (review round 4, finding 2).
export class SecretHoldback {
  #raw = ''
  #sawSecret = false
  readonly #token: string | null
  readonly #holdback: number

  constructor(token: string | null) {
    this.#token = token
    this.#holdback = Math.max(token?.length ?? 0, 256)
  }

  get sawSecret(): boolean {
    return this.#sawSecret
  }

  // Feeds more text; returns the newly-safe (already masked) slice, or '' while everything new is
  // still within the holdback window.
  push(text: string): string {
    this.#raw += text
    let cut = this.#raw.length - this.#holdback
    const ranges = secretRanges(this.#raw, this.#token, false)
    // Detection covers the whole buffer, including the part still held back.
    if (ranges.some((r) => r.secret)) this.#sawSecret = true
    if (cut <= 0) return ''
    for (const range of ranges) if (range.start < cut && range.end > cut) cut = range.start
    // Keep an unterminated JWT until its delimiter arrives, even beyond the normal window.
    for (const match of this.#raw.matchAll(JWT)) if (match.index + match[0].length === this.#raw.length) cut = Math.min(cut, match.index)
    return this.#release(cut, ranges.filter((r) => r.end <= cut))
  }

  // Releases everything still held back, masked as a finished text. Call once at the end of the
  // attempt, or to discard the channel (answer_reset) — `sawSecret` then covers the discarded text.
  flush(): string {
    return this.#release(this.#raw.length, secretRanges(this.#raw, this.#token, true))
  }

  #release(cut: number, ranges: Range[]): string {
    const masked = applyMask(this.#raw.slice(0, cut), ranges)
    if (masked.secret) this.#sawSecret = true
    this.#raw = this.#raw.slice(cut)
    return masked.text
  }
}

// Review rounds 4–5, finding 3: one detector per run concatenates the decoded text of every channel
// (narration, thinking, the decoded answer, tool names, session ids — each string once, never the
// raw reply JSON) and every attempt in stream order, so a token split
// across channels or attempts is still seen whole. Only a bounded tail is kept: a token (or a full
// sk-ant- key) that ends in new text started within the last max(token, 256) characters.
// Accepted residual: pieces shorter than 8 characters deliberately interleaved across channels are
// each too short to mask, so a reader could reassemble them from the owner's loopback UI or the
// gitignored run log. The run still ends failed, and none of it reaches a committed file.
export class SecretDetector {
  #tail = ''
  #sawSecret = false
  readonly #token: string | null
  readonly #keep: number

  constructor(token: string | null) {
    this.#token = token
    this.#keep = Math.max(token?.length ?? 0, 256)
  }

  get sawSecret(): boolean {
    return this.#sawSecret
  }

  feed(text: string): void {
    const seen = this.#tail + text
    if (findSecrets(seen, this.#token).length) this.#sawSecret = true
    this.#tail = seen.slice(-this.#keep)
  }
}
