#!/usr/bin/env node
// Test double for the openspec CLI: `validate <change> --strict` passes when the change has a
// proposal.md under ./openspec/changes/, fails otherwise or when FAKE_OPENSPEC_FAIL is set.
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (process.env.FAKE_OPENSPEC_LOG) appendFileSync(process.env.FAKE_OPENSPEC_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`)
if (args[0] !== 'validate' || !args[1]) {
  process.stderr.write(`fake-openspec: unsupported ${args.join(' ')}\n`)
  process.exit(2)
}
const change = args[1]
if (process.env.FAKE_OPENSPEC_FAIL) {
  process.stdout.write(`✗ ${change}: ${process.env.FAKE_OPENSPEC_FAIL}\n`)
  process.exit(1)
}
if (!existsSync(path.join(process.cwd(), 'openspec', 'changes', change, 'proposal.md'))) {
  process.stdout.write(`✗ ${change}: proposal.md is missing\n`)
  process.exit(1)
}
process.stdout.write(`Change '${change}' is valid\n`)
