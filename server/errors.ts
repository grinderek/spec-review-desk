import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { CommandError } from './git.ts'
import { ReviewFileError } from './review-store.ts'

export class HttpError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message)
  }
}

export function errorResponse(error: Error, c: Context): Response {
  if (error instanceof HttpError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
  if (error instanceof ZodError) {
    const message = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    return c.json({ error: { code: 'invalid_body', message } }, 400)
  }
  if (error instanceof SyntaxError) return c.json({ error: { code: 'invalid_body', message: 'Body is not valid JSON' } }, 400)
  if (error instanceof ReviewFileError) return c.json({ error: { code: 'review_invalid', message: error.message } }, 409)
  console.error(error)
  if (error instanceof CommandError) return c.json({ error: { code: 'command_failed', message: error.message } }, 500)
  return c.json({ error: { code: 'internal', message: 'Unexpected server error — see the server console.' } }, 500)
}
