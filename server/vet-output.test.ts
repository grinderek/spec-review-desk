import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FAKE_OPENSPEC } from './testing/fake-claude-path.ts'
import { FEATURE, NEW_STEPS_MD, SPEC_MD } from './testing/fixtures.ts'
import { writeFiles } from './testing/repo.ts'
import { moveChange, vetAuthorOutput } from './vet-output.ts'

const CHANGE = 'add-hs-email'
const BASE = `openspec/changes/${CHANGE}`
const TOKEN = 'sk-ant-oat01-secret-token-value-0123456789'
let out = ''
let wt = ''
let openspecLog = ''

const goodFiles = (): Record<string, string> => ({
  [`${BASE}/.openspec.yaml`]: 'schema: behavior-driven\ncreated: 2026-09-24\n',
  [`${BASE}/proposal.md`]: '## Why\n\nEmail inputs.\n',
  [`${BASE}/specs/thread-state/spec.md`]: SPEC_MD,
  [`${BASE}/features/thread_state.feature`]: FEATURE,
  [`${BASE}/features/NEW_STEPS.md`]: NEW_STEPS_MD,
})
const vet = () => vetAuthorOutput({ out, change: CHANGE, worktree: wt, openspecBin: FAKE_OPENSPEC, token: TOKEN })

beforeEach(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'sr-vet-out-'))
  wt = await mkdtemp(path.join(os.tmpdir(), 'sr-vet-wt-'))
  openspecLog = path.join(wt, '..', `${path.basename(wt)}-openspec.ndjson`)
  await chmod(FAKE_OPENSPEC, 0o755)
  process.env.FAKE_OPENSPEC_LOG = openspecLog
  delete process.env.FAKE_OPENSPEC_FAIL
  await writeFiles(wt, { 'openspec/specs/inbox/spec.md': '# Inbox\n', 'openspec/changes/other/proposal.md': '## Why\n' })
  await writeFiles(out, goodFiles())
})

describe('vetAuthorOutput', () => {
  it('passes a clean behavior-driven change and validates it in a scratch copy, never the worktree', async () => {
    const result = await vet()
    expect(result.problems).toEqual([])
    expect(result.files).toEqual(['.openspec.yaml', 'features/NEW_STEPS.md', 'features/thread_state.feature', 'proposal.md', 'specs/thread-state/spec.md'])
    expect(result.scenarioKeys).toEqual([
      "features/thread_state.feature::The founder's reply resolves a waiting thread",
      'features/thread_state.feature::A waiting thread is weighted by its age',
    ])
    const [call] = (await readFile(openspecLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; cwd: string })
    expect(call!.args).toEqual(['validate', CHANGE, '--strict'])
    expect(call!.cwd).not.toBe(wt)
    await expect(readFile(path.join(wt, BASE, 'proposal.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses anything besides openspec/changes/<change>/', async () => {
    await writeFiles(out, { 'notes.md': 'x', 'openspec/changes/other-name/proposal.md': 'x' })
    expect((await vet()).problems).toEqual([
      'the output must contain only openspec/changes/add-hs-email/ — found notes.md',
      'the output must contain only openspec/changes/add-hs-email/ — found openspec/changes/other-name',
    ])
  })

  it('refuses symlinks, hidden files and other extensions', async () => {
    await symlink('/etc/passwd', path.join(out, BASE, 'features/passwd.md'))
    await writeFiles(out, { [`${BASE}/.hidden.md`]: 'x', [`${BASE}/features/steps.rb`]: 'x', [`${BASE}/specs/.git/config.yaml`]: 'x' })
    expect((await vet()).problems).toEqual([
      '.hidden.md: hidden files are not allowed',
      'features/passwd.md: symlinks are not allowed',
      'features/steps.rb: only .md, .feature and .yaml files are allowed',
      'specs/.git/config.yaml: hidden files are not allowed',
    ])
  })

  it('refuses the files the Desk owns — a forged review.yaml or decisions.md', async () => {
    await writeFiles(out, { [`${BASE}/review.yaml`]: 'version: 1\napproved_at: 2026-09-24\n', [`${BASE}/decisions.md`]: '# Owner decisions\n' })
    expect((await vet()).problems).toEqual([
      'decisions.md: written by the Desk, never by the author',
      'review.yaml: written by the Desk, never by the author',
    ])
  })

  it('limits the file count and the total size', async () => {
    await writeFiles(out, Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${BASE}/specs/x${i}.md`, 'x'])))
    expect((await vet()).problems).toContain('205 files — at most 200')
    await rm(path.join(out, BASE, 'specs'), { recursive: true })
    await writeFiles(out, { [`${BASE}/big.md`]: 'x'.repeat(5 * 1024 * 1024) })
    expect((await vet()).problems.some((p) => p.startsWith('total size'))).toBe(true)
  })

  it('needs the behavior-driven schema, a new change name, parsing Gherkin and a holding join key', async () => {
    await writeFiles(out, {
      [`${BASE}/.openspec.yaml`]: 'schema: spec-driven\n',
      [`${BASE}/features/broken.feature`]: 'Scenario without a feature\n',
      [`${BASE}/specs/thread-state/spec.md`]: '#### Scenario: Only in the spec\n',
    })
    await mkdir(path.join(wt, BASE), { recursive: true })
    const problems = (await vet()).problems
    expect(problems).toEqual([
      '.openspec.yaml must say schema: behavior-driven',
      'add-hs-email already exists in the worktree',
      expect.stringMatching(/^features\/broken\.feature: /),
      'join key: 1 spec title without a scenario, 2 scenarios without a spec line, 0 duplicate titles',
    ])
  })

  it('finds a secret in any file', async () => {
    await writeFiles(out, { [`${BASE}/proposal.md`]: `## Why\n\ntoken ${TOKEN}\n` })
    expect((await vet()).problems).toEqual(['proposal.md: contains a secret (the OAuth token, an sk-ant- key)'])
  })

  it('reports a failing openspec validate with its output', async () => {
    process.env.FAKE_OPENSPEC_FAIL = 'requirement without scenario'
    expect((await vet()).problems).toEqual(['openspec validate --strict failed: ✗ add-hs-email: requirement without scenario'])
  })

  it('turns a malformed .openspec.yaml into a problem instead of throwing, and moves nothing', async () => {
    await writeFiles(out, { [`${BASE}/.openspec.yaml`]: 'schema: [unterminated\n' })
    const result = await vet()
    expect(result.problems).toEqual([expect.stringMatching(/^\.openspec\.yaml: /)])
    await expect(readFile(path.join(wt, BASE, 'proposal.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symlinked openspec directory in the output', async () => {
    await rm(path.join(out, 'openspec'), { recursive: true })
    await symlink(os.tmpdir(), path.join(out, 'openspec'))
    expect((await vet()).problems).toEqual(['openspec: symlinks are not allowed'])
  })

  it('refuses a symlinked openspec/changes directory in the output', async () => {
    await rm(path.join(out, 'openspec', 'changes'), { recursive: true })
    await symlink(os.tmpdir(), path.join(out, 'openspec', 'changes'))
    expect((await vet()).problems).toEqual(['openspec/changes: symlinks are not allowed'])
  })
})

describe('moveChange', () => {
  it('copies the vetted change into the worktree', async () => {
    const dir = await moveChange(out, CHANGE, wt)
    expect(dir).toBe(path.join(wt, BASE))
    expect(await readFile(path.join(dir, 'features/thread_state.feature'), 'utf8')).toBe(FEATURE)
  })
})
