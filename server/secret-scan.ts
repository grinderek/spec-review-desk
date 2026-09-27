// Spec B §5.2: the OAuth token lives in the claude process environment inside the container, so
// every reply, streamed text, log and output file of a run is scanned for it before anything is
// moved, committed or shown.
const SK_ANT = /sk-ant-[A-Za-z0-9_-]{20,}/g

export const ROTATE_HINT =
  'A secret appeared in the agent output. Nothing was moved or committed and the log was redacted. Rotate the token: run `claude setup-token` and put the new value into tools/spec-review/.env.'

export function findSecrets(text: string, token: string | null): string[] {
  return [
    ...(token && text.includes(token) ? ['the OAuth token'] : []),
    ...(new RegExp(SK_ANT.source).test(text) ? ['an sk-ant- key'] : []),
  ]
}

export function redactSecrets(text: string, token: string | null): string {
  const withoutToken = token ? text.split(token).join('[REDACTED]') : text
  return withoutToken.replace(SK_ANT, '[REDACTED]')
}

// A structured reply streams as many small fragments (the CLI's input_json_delta chunking); no
// single fragment need contain the whole token, but their reassembly (the reconstructed narration
// or answer text) can. Buffer the reconstructed text per channel and release only the part old
// enough that any secret starting in it is guaranteed to have fully arrived — a partial prefix of
// a still-forming secret is never emitted, and detection runs on the whole growing buffer, not on
// each piece in isolation.
export class SecretHoldback {
  #raw = ''
  #emittedLen = 0
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

  // Feeds more text; returns the newly-safe (already redacted) slice, or '' while everything new
  // is still within the holdback window.
  push(text: string): string {
    this.#raw += text
    if (findSecrets(this.#raw, this.#token).length) this.#sawSecret = true
    const redacted = redactSecrets(this.#raw, this.#token)
    const safeLen = Math.max(this.#emittedLen, redacted.length - this.#holdback)
    const out = redacted.slice(this.#emittedLen, safeLen)
    this.#emittedLen = safeLen
    return out
  }

  // Releases everything still held back, redacted. Call once at the end of the attempt (or to
  // discard/restart the channel, e.g. on answer_reset — read `sawSecret` first if so).
  flush(): string {
    const redacted = redactSecrets(this.#raw, this.#token)
    const out = redacted.slice(this.#emittedLen)
    this.#emittedLen = redacted.length
    return out
  }
}
