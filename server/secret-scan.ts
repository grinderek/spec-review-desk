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
