import { describe, expect, it } from 'vitest'
import { createBaseApp } from './app.ts'
import { TEST_PORT, TEST_TOKEN, testContext } from './testing/http.ts'

function app() {
  const a = createBaseApp(testContext('/tmp'))
  a.get('/api/ping', (c) => c.json({ ok: true }))
  a.post('/api/ping', (c) => c.json({ ok: true }))
  a.get('/index.html', (c) => c.text('page'))
  return a
}
const url = (p: string) => `http://127.0.0.1:${TEST_PORT}${p}`
const good = { host: `127.0.0.1:${TEST_PORT}`, origin: `http://127.0.0.1:${TEST_PORT}`, cookie: `sr_token=${TEST_TOKEN}` }

describe('security middleware', () => {
  it('refuses a foreign Host (DNS rebinding)', async () => {
    const res = await app().request(url('/api/ping'), { headers: { ...good, host: 'evil.example:4600' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('bad_host')
  })

  it('refuses a write without a same-origin Origin header', async () => {
    const res = await app().request(url('/api/ping'), { method: 'POST', headers: { ...good, origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    const missing = await app().request(url('/api/ping'), { method: 'POST', headers: { host: good.host, cookie: good.cookie } })
    expect(missing.status).toBe(403)
  })

  it('requires the session cookie on /api but not on static files', async () => {
    expect((await app().request(url('/api/ping'), { headers: { host: good.host } })).status).toBe(401)
    expect((await app().request(url('/api/ping'), { headers: good })).status).toBe(200)
    expect((await app().request(url('/index.html'), { headers: { host: good.host } })).status).toBe(200)
  })

  it('accepts the dev UI origin', async () => {
    const res = await app().request(url('/api/ping'), { method: 'POST', headers: { ...good, origin: 'http://127.0.0.1:5173' } })
    expect(res.status).toBe(200)
  })

  it('exchanges the token for an HttpOnly SameSite=Strict cookie', async () => {
    const res = await app().request(url('/api/session'), {
      method: 'POST',
      headers: { host: good.host, origin: good.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_TOKEN }),
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/sr_token=test-token;.*HttpOnly.*SameSite=Strict/i)
    const wrong = await app().request(url('/api/session'), {
      method: 'POST',
      headers: { host: good.host, origin: good.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    })
    expect(wrong.status).toBe(401)
  })
})
