import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Vitest globalSetup (final review I5): every mkdtemp of the suite — the tests' own dirs and those
// of the fake Codex/git/docker children — lands under one root that teardown removes. Workers and
// their children inherit TMPDIR, and os.tmpdir() reads it on every call.
export default function setup(): () => void {
  const previous = process.env.TMPDIR
  const root = mkdtempSync(path.join(os.tmpdir(), 'sr-vitest-'))
  process.env.TMPDIR = root
  return () => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}
