import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emptyInitiative, findRun, findSlice, INITIATIVE_FILE, InitiativeFileError, initiativeDir, isInitiativeName, readInitiative,
  type RunRecord, updateInitiative, upsertRun, writeInitiative,
} from './initiative-store.ts'

const AT = '2026-09-24T10:00:00.000Z'
const dir = () => mkdtemp(path.join(os.tmpdir(), 'sr-initiative-'))
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r_00000001', kind: 'planner', slice: null, topic: null, session: 's-1', container: 'sr-r_00000001',
  log: '.spec-review/runs/r_00000001.ndjson', started_at: AT, ended_at: null, outcome: 'running', notes: null, ...over,
})

describe('initiative names and paths', () => {
  it('accepts slugs of 2 to 41 characters only', () => {
    expect(isInitiativeName('health-score')).toBe(true)
    expect(isInitiativeName('a')).toBe(false)
    expect(isInitiativeName('-lead')).toBe(false)
    expect(isInitiativeName('Health')).toBe(false)
    expect(isInitiativeName(`a${'b'.repeat(41)}`)).toBe(false)
    expect(isInitiativeName('../x')).toBe(false)
  })

  it('places an initiative under openspec/initiatives', () => {
    expect(initiativeDir('/w', 'health-score')).toBe(path.join('/w', 'openspec', 'initiatives', 'health-score'))
    expect(() => initiativeDir('/w', '../x')).toThrow(/invalid initiative name/)
    let error: unknown
    try {
      initiativeDir('/w', '../x')
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ status: 422, code: 'invalid_name' })
  })
})

describe('initiative.yaml', () => {
  it('round-trips a full document and fills defaults for a minimal one', async () => {
    const d = await dir()
    await writeFile(path.join(d, INITIATIVE_FILE), 'version: 1\nname: health-score\ntitle: Business health score\nrepo: api\ncreated_at: x\n')
    const minimal = await readInitiative(d)
    expect(minimal).toEqual(emptyInitiative({ name: 'health-score', title: 'Business health score', repo: 'api', created_at: 'x' }))
    expect(minimal.plan).toEqual({ status: 'none', approved_at: null, slices: [] })
    const full = {
      ...minimal,
      inputs: [
        { file: 'spec.pdf', bytes: 3, source: { kind: 'upload' as const }, added_at: AT, draft: false },
        { file: 'research-intuit.md', bytes: 9, source: { kind: 'research' as const, run: 'r_1', domains: ['developer.intuit.com'] }, added_at: AT, draft: true },
        { file: 'c.md', bytes: 5, source: { kind: 'repo' as const, path: 'api/doc/c.md', commit: '13ad9bd' }, added_at: AT, draft: false },
      ],
      research: { domains: ['developer.intuit.com'] },
      plan: {
        status: 'approved' as const,
        approved_at: AT,
        slices: [{ id: 's1', title: 'Engine', scope: 'The pure engine.', depends_on: [], change: 'add-health-score-engine' }],
      },
      runs: [run({ kind: 'research', topic: 'Intuit reports', phase: 'search' })],
    }
    await writeInitiative(d, full)
    expect(await readInitiative(d)).toEqual(full)
    expect(await readFile(path.join(d, INITIATIVE_FILE), 'utf8')).toContain('name: health-score')
  })

  it('names the file and the issues of an invalid document', async () => {
    const d = await dir()
    await writeFile(path.join(d, INITIATIVE_FILE), 'version: 1\nname: Bad Name\n')
    await expect(readInitiative(d)).rejects.toBeInstanceOf(InitiativeFileError)
    await expect(readInitiative(d)).rejects.toThrow(/name/)
  })

  it('reports a missing initiative as 404', async () => {
    await expect(readInitiative(await dir())).rejects.toMatchObject({ status: 404, code: 'unknown_initiative' })
  })

  it('serializes updates and upserts runs without mutating the input', async () => {
    const d = await dir()
    await writeInitiative(d, emptyInitiative({ name: 'hs', title: 'T', repo: 'api', created_at: AT }))
    await Promise.all([
      updateInitiative(d, (doc) => upsertRun(doc, run({ id: 'r_a' }))),
      updateInitiative(d, (doc) => upsertRun(doc, run({ id: 'r_b' }))),
    ])
    const doc = await readInitiative(d)
    expect(doc.runs.map((r) => r.id).sort()).toEqual(['r_a', 'r_b'])
    const frozen = JSON.stringify(doc)
    const next = upsertRun(doc, { ...findRun(doc, 'r_a'), outcome: 'done' })
    expect(JSON.stringify(doc)).toBe(frozen)
    expect(findRun(next, 'r_a').outcome).toBe('done')
    expect(() => findRun(doc, 'r_nope')).toThrow(/No run r_nope/)
    expect(() => findSlice(doc, 's9')).toThrow(/No slice s9/)
  })
})
