import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

// Cookies are shared across ports on a host. Each Desk instance needs its own name.
export const tokenCookie = (port: number): string => `sr_token_${port}`

export interface SecurityOptions { token: string; cookieName: string; allowedHosts: string[]; allowedOrigins: string[] }

export function allowedFor(port: number, devUiOrigin: string): { allowedHosts: string[]; allowedOrigins: string[] } {
  const dev = new URL(devUiOrigin)
  return {
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, dev.host],
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, dev.origin],
  }
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function security(opts: SecurityOptions): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!opts.allowedHosts.includes(host)) {
      return c.json({ error: { code: 'bad_host', message: `Host ${host || '(none)'} is not allowed` } }, 403)
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (!origin || !opts.allowedOrigins.includes(origin)) {
        return c.json({ error: { code: 'bad_origin', message: 'Cross-origin request refused' } }, 403)
      }
    }
    const pathname = new URL(c.req.url).pathname
    if (pathname.startsWith('/api/') && pathname !== '/api/session' && !tokenMatches(opts.token, getCookie(c, opts.cookieName))) {
      return c.json({ error: { code: 'unauthorized', message: 'Open the URL printed in the server console to sign in.' } }, 401)
    }
    await next()
  }
}
