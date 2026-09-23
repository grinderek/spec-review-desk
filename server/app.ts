import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { Registry } from './discovery.ts'
import { errorResponse, HttpError } from './errors.ts'
import type { EventBus } from './events.ts'
import { allowedFor, security, TOKEN_COOKIE, tokenMatches } from './security.ts'

export interface AppContext { config: Config; token: string; bus: EventBus; registry: Registry }

export function createBaseApp(ctx: AppContext): Hono {
  const app = new Hono()
  app.onError((error, c) => errorResponse(error, c))
  app.use('*', security({ token: ctx.token, ...allowedFor(ctx.config.port, ctx.config.devUiOrigin) }))
  app.post('/api/session', async (c) => {
    const { token } = z.object({ token: z.string() }).parse(await c.req.json())
    if (!tokenMatches(ctx.token, token)) throw new HttpError(401, 'unauthorized', 'Wrong token — use the URL printed at startup.')
    setCookie(c, TOKEN_COOKIE, ctx.token, { httpOnly: true, sameSite: 'Strict', path: '/' })
    return c.body(null, 204)
  })
  return app
}
