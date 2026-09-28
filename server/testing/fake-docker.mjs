#!/usr/bin/env node
// Test double for the docker CLI (spec B §12: no real docker in vitest). Logs every argv (and the
// agent's stdin) to FAKE_DOCKER_LOG and answers like docker would:
// - FAKE_DOCKER_DOWN=1: `version` fails; FAKE_DOCKER_MISSING=a,b: `image inspect a` fails;
// - FAKE_DOCKER_EGRESS_FAIL=1: starting the proxy (`run -d --name sr-egress-…`) fails;
// - FAKE_DOCKER_BROWSER_FAIL=1: starting the research browser (`run -d --name sr-browser-…`) fails;
//   `logs sr-browser-…` prints the MCP server's "Listening on" line unless FAKE_DOCKER_BROWSER_SILENT=1;
// - the agent (`run --rm -i`) prints an init and a result line, or with FAKE_DOCKER_HANG=1 waits
//   until `docker kill <name>` signals it (pid files under FAKE_DOCKER_STATE).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const state = process.env.FAKE_DOCKER_STATE ?? path.join(process.cwd(), '.fake-docker')
mkdirSync(state, { recursive: true })
const log = (entry) => {
  if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(entry)}\n`)
}
const nameOf = () => args[args.indexOf('--name') + 1]

if (args[0] === 'version') {
  log({ args })
  if (process.env.FAKE_DOCKER_DOWN) process.exit(1)
  process.stdout.write('29.0.0\n')
  process.exit(0)
}
if (args[0] === 'image' && args[1] === 'inspect') {
  log({ args })
  const missing = (process.env.FAKE_DOCKER_MISSING ?? '').split(',').filter(Boolean)
  process.exit(missing.includes(args[2]) ? 1 : 0)
}
if (args[0] === 'kill') {
  log({ args })
  try {
    process.kill(Number(readFileSync(path.join(state, `${args[1]}.pid`), 'utf8')), 'SIGTERM')
  } catch {
    // not running
  }
  process.exit(0)
}
if (args[0] === 'run' && args[1] === '-d') {
  log({ args })
  const browser = nameOf().startsWith('sr-browser-')
  process.exit((browser ? process.env.FAKE_DOCKER_BROWSER_FAIL : process.env.FAKE_DOCKER_EGRESS_FAIL) ? 1 : 0)
}
if (args[0] === 'logs') {
  log({ args })
  if (!process.env.FAKE_DOCKER_BROWSER_SILENT) process.stderr.write('Listening on http://localhost:8931\n')
  process.exit(0)
}
if (args[0] === 'run' && args.includes('-i')) {
  const stdin = readFileSync(0, 'utf8')
  log({ args, stdin })
  const name = nameOf()
  writeFileSync(path.join(state, `${name}.pid`), String(process.pid))
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  emit({ type: 'system', subtype: 'init', session_id: 'fake-docker-session' })
  if (process.env.FAKE_DOCKER_HANG) {
    process.on('SIGTERM', () => process.exit(137))
    setInterval(() => undefined, 1000)
  } else {
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: 'fake-docker-session' })
    process.exit(0)
  }
} else {
  log({ args })
  process.exit(0)
}
