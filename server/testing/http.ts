import path from 'node:path'
import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import type { Config } from '../config.ts'
import { Registry } from '../discovery.ts'
import { EventBus } from '../events.ts'

export const TEST_TOKEN = 'test-token'
export const TEST_PORT = 4600

export function testConfig(repoPath: string, overrides: Partial<Config> = {}): Config {
  return {
    port: TEST_PORT,
    hubRoot: repoPath,
    repos: [{ name: 'api', path: repoPath }],
    model: 'opus',
    claudeBin: 'claude',
    commitTrailer: 'Co-Authored-By: Test <test@example.com>',
    questionTimeoutMs: 10_000,
    devUiOrigin: 'http://127.0.0.1:5173',
    runners: [],
    sandbox: {
      image: 'spec-review-agent:test',
      egressImage: 'spec-review-egress:test',
      envFile: path.join(repoPath, '.sandbox.env'),
      timeoutMs: 20_000,
      dockerBin: 'docker',
    },
    openspecBin: 'openspec',
    initiativeBase: 'main',
    ...overrides,
  }
}

export function testContext(repoPath: string, overrides: Partial<Config> = {}): AppContext {
  return { config: testConfig(repoPath, overrides), token: TEST_TOKEN, bus: new EventBus(), registry: new Registry() }
}

export async function call(app: Hono, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${TEST_PORT}`,
    origin: `http://127.0.0.1:${TEST_PORT}`,
    cookie: `sr_token=${TEST_TOKEN}`,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(`http://127.0.0.1:${TEST_PORT}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

export async function callForm(app: Hono, url: string, form: FormData): Promise<{ status: number; json: any }> {
  const res = await app.request(`http://127.0.0.1:${TEST_PORT}${url}`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${TEST_PORT}`, origin: `http://127.0.0.1:${TEST_PORT}`, cookie: `sr_token=${TEST_TOKEN}` },
    body: form,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
