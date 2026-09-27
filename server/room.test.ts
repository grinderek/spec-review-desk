import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { emptyInitiative, type InitiativeDoc } from './initiative-store.ts'
import { assembleRoom, extractSection } from './room.ts'
import { writeFiles } from './testing/repo.ts'

const AT = '2026-09-24T10:00:00.000Z'
const CLAUDE_MD = '# Api\n\nIntro.\n\n## Spec-driven work\n\nScenarios first.\n\n### Detail\n\nKept.\n\n## Deploy\n\nNot copied.\n'

async function world() {
  const wt = await mkdtemp(path.join(os.tmpdir(), 'sr-room-wt-'))
  const ini = path.join(wt, 'openspec/initiatives/hs')
  await writeFiles(wt, {
    'CLAUDE.md': CLAUDE_MD,
    '.claude/rules/testing.md': '# Testing\n',
    'openspec/schemas/behavior-driven/schema.yaml': 'name: behavior-driven\n',
    'openspec/schemas/behavior-driven/templates/proposal.md': '## Why\n',
    'openspec/specs/inbox/spec.md': '# Inbox\n',
    'features/STEPS.md': '# Steps\n',
    'features/inbox/threads.feature': 'Feature: Threads\n',
    'features/support/env.rb': 'secret = 1\n',
    'app/models/user.rb': 'class User; end\n',
    'openspec/initiatives/hs/brief.md': '# Brief\n',
    'openspec/initiatives/hs/decisions.md': '# Owner decisions — hs\n',
    'openspec/initiatives/hs/review.yaml': 'version: 1\n',
    'openspec/initiatives/hs/initiative.yaml': 'not copied as is\n',
    'openspec/initiatives/hs/inputs/spec.md': '# Spec\n',
    'openspec/initiatives/hs/inputs/research-intuit.md': '# Draft research\n',
    'openspec/changes/add-hs-engine/proposal.md': '## Why\n',
    'openspec/changes/add-hs-engine/design.md': '## Design\n',
    'openspec/changes/add-hs-engine/tasks.md': '- [ ] x\n',
    'openspec/changes/add-hs-engine/RESULT.md': 'green\n',
    'openspec/changes/add-hs-engine/review.yaml': 'version: 1\n',
    'openspec/changes/add-hs-engine/decisions.md': '# Owner decisions — add-hs-engine\n',
    'openspec/changes/add-hs-engine/specs/score/spec.md': '## ADDED Requirements\n',
    'openspec/changes/add-hs-engine/features/engine.feature': 'Feature: Engine\n',
    'openspec/changes/add-hs-engine/features/NEW_STEPS.md': '# New\n',
  })
  await symlink('/etc/passwd', path.join(wt, 'features/inbox/passwd.feature'))
  await mkdir(path.join(wt, 'outside'))
  await symlink(path.join(wt, 'outside'), path.join(wt, 'openspec/specs/linked'))
  const doc: InitiativeDoc = {
    ...emptyInitiative({ name: 'hs', title: 'Health score', repo: 'api', created_at: AT }),
    inputs: [
      { file: 'spec.md', bytes: 7, source: { kind: 'upload' }, added_at: AT, draft: false },
      { file: 'research-intuit.md', bytes: 17, source: { kind: 'research', run: 'r_1', domains: [] }, added_at: AT, draft: true },
    ],
    plan: {
      status: 'approved',
      approved_at: AT,
      slices: [
        { id: 's1', title: 'Engine', scope: 'Pure engine.', depends_on: [], change: 'add-hs-engine' },
        { id: 's2', title: 'Email', scope: 'Email inputs.', depends_on: ['s1'], change: null },
        { id: 's3', title: 'Later', scope: 'Later.', depends_on: ['s2'], change: 'add-hs-later' },
      ],
    },
  }
  return { wt, ini, doc, statuses: { s1: 'approved' as const, s2: 'planned' as const, s3: 'planned' as const } }
}

const METHOD_AND_CORPUS = [
  'corpus/features/STEPS.md',
  'corpus/features/inbox/threads.feature',
  'corpus/specs/inbox/spec.md',
  'method/schema/schema.yaml',
  'method/schema/templates/proposal.md',
  'method/spec-driven-work.md',
  'method/testing.md',
]

describe('assembleRoom', () => {
  it('gives the author the initiative, earlier slices, the corpus and the method — nothing else', async () => {
    const { wt, ini, doc, statuses } = await world()
    const room = path.join(await mkdtemp(path.join(os.tmpdir(), 'sr-room-')), 'room')
    const files = await assembleRoom(room, {
      worktree: wt, initiativeDir: ini, doc, kind: 'author', statuses,
      target: { sliceId: 's2', notes: 'Keep it small.', change: 'add-hs-email' },
    })
    expect(files).toEqual([
      ...METHOD_AND_CORPUS.slice(0, 3),
      'initiative/brief.md',
      'initiative/decisions.md',
      'initiative/inputs/spec.md',
      'initiative/plan.yaml',
      ...METHOD_AND_CORPUS.slice(3),
      'slices/add-hs-engine/decisions.md',
      'slices/add-hs-engine/features/NEW_STEPS.md',
      'slices/add-hs-engine/features/engine.feature',
      'slices/add-hs-engine/proposal.md',
      'slices/add-hs-engine/specs/score/spec.md',
    ])
    const plan = parse(await readFile(path.join(room, 'initiative/plan.yaml'), 'utf8')) as Record<string, unknown>
    expect(plan).toMatchObject({ initiative: 'hs', target: 's2', change: 'add-hs-email', notes: 'Keep it small.' })
    expect((plan.slices as { id: string; status: string }[]).map((s) => [s.id, s.status])).toEqual([['s1', 'approved'], ['s2', 'planned'], ['s3', 'planned']])
    expect(await readFile(path.join(room, 'method/spec-driven-work.md'), 'utf8')).toBe('## Spec-driven work\n\nScenarios first.\n\n### Detail\n\nKept.\n')
  })

  it('gives the planner every proposed slice and no target', async () => {
    const { wt, ini, doc, statuses } = await world()
    const room = path.join(await mkdtemp(path.join(os.tmpdir(), 'sr-room-')), 'room')
    const files = await assembleRoom(room, { worktree: wt, initiativeDir: ini, doc, kind: 'planner', statuses })
    expect(files.filter((f) => f.startsWith('slices/'))).toHaveLength(5)
    expect(files).not.toContain('initiative/inputs/research-intuit.md')
    expect((parse(await readFile(path.join(room, 'initiative/plan.yaml'), 'utf8')) as { target: unknown }).target).toBeNull()
  })

  it('gives research only the brief and the accepted inputs', async () => {
    const { wt, ini, doc, statuses } = await world()
    const room = path.join(await mkdtemp(path.join(os.tmpdir(), 'sr-room-')), 'room')
    expect(await assembleRoom(room, { worktree: wt, initiativeDir: ini, doc, kind: 'research', statuses })).toEqual([
      'initiative/brief.md',
      'initiative/inputs/spec.md',
    ])
    const accepted = { ...doc, inputs: doc.inputs.map((i) => ({ ...i, draft: false })) }
    const again = path.join(await mkdtemp(path.join(os.tmpdir(), 'sr-room-')), 'room')
    expect(await assembleRoom(again, { worktree: wt, initiativeDir: ini, doc: accepted, kind: 'research', statuses })).toContain('initiative/inputs/research-intuit.md')
  })
})

describe('extractSection', () => {
  it('cuts one heading with its sub-headings', () => {
    expect(extractSection(CLAUDE_MD, 'Spec-driven work')).toBe('## Spec-driven work\n\nScenarios first.\n\n### Detail\n\nKept.\n')
    expect(extractSection('# Nothing\n', 'Spec-driven work')).toBeNull()
  })
})
