import { executeOwnerDecision } from '../decision-commands.ts'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import type { Hono } from 'hono'
import { createBaseApp, type AppContext } from '../app.ts'
import { contractKey } from '../contract-identity.ts'
import { contractHash, type DeskScenario } from '../desk-dsl.ts'
import { parseCatalog } from '../catalog.ts'
import { parseNativeContract } from '../change-package.ts'
import { git, headSha } from '../git.ts'
import { QuestionService } from '../questions.ts'
import { FAKE_CODEX } from './fake-codex-path.ts'
import {
  readReviewEvents, recordApprovalEvents, recordReviewEvents,
  type ApprovalEvent, type DecisionRecord, type Entry, type Section, emptyReview,
} from '../review-store.ts'
import { registerReadRoutes } from '../routes/read.ts'
import { registerReviewRoutes } from '../routes/review.ts'
import { call, testContext } from './http.ts'
import { recoverChangeApproval, requestChangeApproval } from '../approval-effects.ts'
import { withWorktreeAdmission } from '../execution-admission.ts'
import { executeGitEffect } from '../git-effect.ts'
import { readReview, withReviewLock } from '../review-store.ts'
import { sh, writeFiles } from './repo.ts'

// The adapter contains transport and environment mechanics only; expectations live in DSL.
export class ReviewWorld {
  readonly vars: Record<string, unknown>
  private readonly subject: DeskScenario = { id: 'subject', scenario: 'Subject contract', given: [], when: { Inspect: {} }, then: { events: [], response: { status: 200 } } }
  readonly app: Hono
  readonly ctx: AppContext
  readonly questions: QuestionService
  agentReply: Record<string, unknown> = { answer: 'Noted.', patch: null, decisions: [], resolves: [], status: 'answered' }
  agentUsageReported = true
  private subjectRel = 'features/subject.desk.yaml'
  private constructor(readonly repo: string, head: string) {
    this.ctx = testContext(repo, { commitTrailer: '', codexBin: FAKE_CODEX })
    this.app = createBaseApp(this.ctx)
    this.questions = new QuestionService({ config: this.ctx.config, bus: this.ctx.bus,
      // The actual detached transport executes a deterministic local CLI.
      environment: () => ({ FAKE_CODEX_REPLY: JSON.stringify(this.agentReply), FAKE_CODEX_REPLY_FILE: '', FAKE_CODEX_REPLIES_FILE: '', FAKE_CODEX_OMIT_USAGE: this.agentUsageReported ? '' : '1' }),
    })
    registerReadRoutes(this.app, this.ctx, { codex: false, docker: false })
    registerReviewRoutes(this.app, this.ctx, { questions: this.questions })
    this.vars = { key: contractKey(this.subjectRel, 'subject'), hash: contractHash(this.subject), head, at: '2026-10-01T00:00:00.000Z' }
  }
  static async create(): Promise<ReviewWorld> {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'desk-dsl-'))
    try {
      sh(repo, 'git', ['init', '-q', '-b', 'main'])
      sh(repo, 'git', ['config', 'user.email', 'spec@example.com'])
      sh(repo, 'git', ['config', 'user.name', 'Desk specs'])
      await writeFiles(repo, { 'README.md': 'DSL fixture\n', 'desk/changes/subject/change.yaml': 'version: 1\nkind: behavior-driven\n' })
      sh(repo, 'git', ['add', '-A']); sh(repo, 'git', ['commit', '-q', '-m', 'fixture'])
      return new ReviewWorld(repo, await headSha(repo))
    } catch (error) { await rm(repo, { recursive: true, force: true }); throw error }
  }
  get dir(): string { return path.join(this.repo, 'desk/changes/subject') }
  private get sourceFile(): string { return path.join(this.dir, this.subjectRel) }
  resolve(value: unknown): any {
    if (typeof value === 'string') {
      const exact = /^\$([a-z][a-zA-Z0-9]*)$/.exec(value)
      if (exact) { if (!(exact[1]! in this.vars)) throw Error(`Unknown binding ${value}`); return this.vars[exact[1]!] }
      return value.replace(/\$([a-z][a-zA-Z0-9]*)/g, (_, name: string) => {
        if (!(name in this.vars)) throw Error(`Unknown binding $${name}`)
        return String(this.vars[name])
      })
    }
    if (Array.isArray(value)) return value.map((v) => this.resolve(v))
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [String(this.resolve(key)), this.resolve(v)])) : value
  }
  private entry(data: Record<string, any>, status: Entry['status'] = 'approved'): Entry {
    return { status, text_hash: data.hash, approved_commit: data.commit ?? null, at: data.at ?? String(this.vars.at) }
  }
  private async priorEntry(section: Section, key: string, entry: Entry): Promise<void> {
    const event: ApprovalEvent = section === 'scenarios'
      ? entry.status === 'approved' ? { type: 'ScenarioApproved', key, entry: { ...entry, status: 'approved' } }
        : { type: 'ScenarioChangesRequested', key, entry: { ...entry, status: 'changes_requested' } }
      : entry.status === 'approved' ? { type: 'PhraseApproved', key, entry: { ...entry, status: 'approved' } }
        : { type: 'PhraseChangesRequested', key, entry: { ...entry, status: 'changes_requested' } }
    await recordApprovalEvents(this.dir, async () => ({ events: [event] }), 'fixture')
  }
  async given(name: string, data: Record<string, any>): Promise<void> {
    if (name === 'ScenarioDiscovered' || name === 'ScenarioRevised') {
      if (data.file) this.subjectRel = data.file
      if (data.format === 'gherkin') this.subjectRel = 'features/subject.feature'
      if (data.status) this.subject.then.response.status = Number(data.status)
      await mkdir(path.dirname(this.sourceFile), { recursive: true })
      const source = data.format === 'gherkin'
        ? 'Feature: Subject\n  @id:subject\n  Scenario: Subject contract\n    Given the source is available\n    When the owner reviews "subject"\n    Then the response is available\n'
        : stringify({ version: 1, feature: 'Subject', scenarios: [this.subject] })
      await writeFile(this.sourceFile, source)
      if (data.format === 'gherkin') await writeFiles(this.repo, { 'features/STEPS.md': '## Given\n\n| Phrase | Meaning |\n|---|---|\n| `the source is available` | The source is available. |\n\n## Then\n\n| Phrase | Meaning |\n|---|---|\n| `the response is available` | The response is available. |\n' })
      this.vars.key = contractKey(this.subjectRel, 'subject')
      this.vars.hash = data.format === 'gherkin' ? parseNativeContract(source, this.subjectRel).contracts[0]!.hash : contractHash(this.subject)
      if (name === 'ScenarioDiscovered') { sh(this.repo, 'git', ['add', '-A']); sh(this.repo, 'git', ['commit', '-q', '-m', 'source contract discovered']); this.vars.head = await headSha(this.repo) }
    } else if (name === 'ScenarioRetitled') {
      this.subject.scenario = String(data.title)
      await writeFile(this.sourceFile, stringify({ version: 1, feature: 'Subject', scenarios: [this.subject] }))
      this.vars.hash = contractHash(this.subject)
    } else if (name === 'ChangeMetadataChanged') {
      const file = path.join(this.dir, 'change.yaml')
      if (data.mode === 'missing') await rm(file)
      else await writeFile(file, 'version: 1\nkind: unsupported\n')
    } else if (name === 'ScenarioApproved' || name === 'ScenarioChangesRequested' || name === 'PhraseApproved') {
      await this.priorEntry(name === 'PhraseApproved' ? 'phrases' : 'scenarios', data.key, this.entry(data, name === 'ScenarioChangesRequested' ? 'changes_requested' : 'approved'))
    } else if (name === 'ReviewEntryRecorded') {
      await this.priorEntry(data.section, data.key, this.entry(data))
    } else if (name === 'ScenarioReformatted') await writeFile(this.sourceFile, '# Presentation-only change\n' + stringify({ scenarios: [this.subject], feature: 'Subject', version: 1 }))
    else if (name === 'PhraseProposed') {
      const phrase = data.phrase ?? 'the owner reviews {string}'
      const meaning = data.meaning ?? 'The proposed phrase.'
      const source = `## When\n\n| Phrase | ${data.extension ? 'Extended meaning' : 'Meaning'} | Command |\n|---|---|---|\n| \`${phrase}\` | ${meaning} | \`ReviewContract\` |\n`
      await writeFiles(this.repo, { 'desk/changes/subject/features/NEW_STEPS.md': source })
      const entry = parseCatalog(source).phrases[0]!
      this.vars.phrase = entry.key; this.vars.phraseHash = entry.hash
    } else if (name === 'ReviewThreadOpened') {
      await recordReviewEvents(this.dir, async () => ({ events: [{ type: 'DiscussionOpened', thread: { id: data.id ?? 't_fixture', anchor: data.anchor ?? 'change', ref: data.ref ?? '', status: data.status ?? 'open', messages: data.messages ?? [] } }] }), 'fixture')
    } else if (name === 'DecisionRaised') {
      this.vars.decision = data.id ?? 'd_fixture'
      const decision: DecisionRecord = { id: data.id ?? 'd_fixture', agent_id: data.agent_id ?? null, source: data.source ?? { kind: 'owner' }, question: data.question ?? 'Owner choice?',
        scope: data.scope ?? { kind: 'change' }, options: data.options ?? [], recommended: data.recommended ?? null, blocking: data.blocking ?? true, status: data.status ?? 'open',
        choice: data.choice ?? null, recorded: data.recorded ?? null, dismissed: data.dismissed ?? null, created_at: String(this.vars.at),
        ...(data.requested_domains ? { requested_domains: data.requested_domains } : {}), }
      const status = decision.status
      await executeOwnerDecision(this.dir, { type: 'RaiseOwnerDecisions', decisions: [{ ...decision, status: 'open', choice: null, recorded: null, dismissed: null }] }, 'fixture')
      if (status === 'decided' || status === 'recorded') {
        await executeOwnerDecision(this.dir, { type: 'ChooseOwnerDecision', id: decision.id,
          choice: decision.choice ?? { option: decision.options[0]?.id ?? null, note: 'Fixture owner choice' }, at: String(this.vars.at) }, 'fixture')
      }
      if (status === 'recorded') await executeOwnerDecision(this.dir, { type: 'RecordOwnerDecision', id: decision.id,
        recorded: decision.recorded ?? { how: 'decisions_md', commit: (await git(this.repo, ['rev-parse', 'HEAD'])).trim() } }, 'fixture')
      if (status === 'dismissed') await executeOwnerDecision(this.dir, { type: 'DismissOwnerDecision', id: decision.id,
        reason: decision.dismissed?.reason ?? 'Outside the fixture scope', at: String(this.vars.at) }, 'fixture')
    } else if (name === 'ReviewProjectionDamaged') {
      const file = path.join(this.dir, 'review.yaml')
      if (data.mode === 'lost') await rm(file, { force: true })
      else if (data.mode === 'stale') await writeFile(file, stringify(emptyReview()))
      else if (data.mode === 'corrupt') await writeFile(file, 'version: [corrupted projection\n')
      else throw new Error(`Unknown projection condition ${data.mode}`)
    } else if (name === 'ApprovalCommitRejected' || name === 'ApprovalCommitFailed') {
      const hook = path.join(this.repo, '.git/hooks/pre-commit')
      await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755)
      if (name === 'ApprovalCommitFailed') {
        await this.ready()
        const result = await this.command('RecordChangeApproval', {})
        if (result.status !== 409) throw Error('Expected the configured commit rejection')
        this.vars.approvalEffect = (await readReview(this.dir)).git_effects.at(-1)!.plan.effectId
        await rm(hook)
      }
    } else if (name === 'ChangeApprovalCompleted') {
      await this.ready()
      const result = await this.command('RecordChangeApproval', {})
      if (result.status !== 200) throw Error('Could not record prior owner approval')
      this.vars.approvalCommit = result.body.commit
    } else if (name === 'ApprovalReceiptAwaitingRecovery' || name === 'ApprovalRecovered') {
      await this.ready()
      const wt = this.ctx.registry.all()[0]!
      const ref = { worktreeId: wt.id, dir: this.dir, name: 'subject', archived: false, mtimeMs: 0 }
      await withWorktreeAdmission(this.repo, () => withReviewLock(this.dir, async () => {
        const plan = await requestChangeApproval(wt, ref, '')
        const receipt = await executeGitEffect(this.repo, plan)
        if (receipt.status !== 'completed') throw Error('Could not prepare the committed approval receipt')
        this.vars.approvalEffect = plan.effectId; this.vars.approvalCommit = receipt.commit
      }))
      if (name === 'ApprovalRecovered') await recoverChangeApproval(wt, ref)
    } else throw Error(`Unsupported Given event ${name}`)
  }
  async ready(): Promise<void> {
    await call(this.app, 'GET', '/api/changes')
    const wt = this.ctx.registry.all()[0]!
    this.vars.change = `/api/changes/${wt.id}/subject`
    if ('target' in this.vars) this.vars.targetKey = this.vars.target === 'phrase' ? this.vars.phrase : this.vars.target === 'missing' ? 'missing' : this.vars.key
  }
  async events() { return readReviewEvents(this.dir) }
  async command(name: string, data: Record<string, any>) {
    const base = String(this.vars.change)
    if (name === 'RecoverApproval') {
      const wt = this.ctx.registry.all()[0]!
      await recoverChangeApproval(wt, { worktreeId: wt.id, dir: this.dir, name: 'subject', archived: false, mtimeMs: 0 })
      return { status: 200, body: { ok: true } }
    }
    const commands: Record<string, { method: string; path: string; body?: unknown }> = {
      ApproveScenario: { method: 'POST', path: `${base}/scenarios/approve`, body: { key: data.key } },
      RevokeScenarioApproval: { method: 'POST', path: `${base}/scenarios/revoke`, body: { key: data.key } },
      RequestScenarioChanges: { method: 'POST', path: `${base}/scenarios/request-changes`, body: { key: data.key, reason: data.reason } },
      ApprovePhrase: { method: 'POST', path: `${base}/phrases/approve`, body: { key: data.key } },
      RevokePhraseApproval: { method: 'POST', path: `${base}/phrases/revoke`, body: { key: data.key } },
      RecordChangeApproval: { method: 'POST', path: `${base}/approval` },
      DropOrphanReview: { method: 'POST', path: `${base}/orphans/drop`, body: data },
      ReattachOrphanReview: { method: 'POST', path: `${base}/orphans/reattach`, body: data },
      ReadChange: { method: 'GET', path: base },
      ReadChangeSummary: { method: 'GET', path: '/api/changes' },
      HttpRequest: { method: data.method, path: data.path, body: data.body },
    }
    const request = commands[name]
    if (!request) throw Error(`Unsupported command ${name}`)
    const response = await call(this.app, request.method, request.path, request.body)
    await this.questions.idle(this.dir)
    return { status: response.status, body: response.json }
  }
  async read(url: string) {
    const response = await call(this.app, 'GET', url)
    return { status: response.status, body: response.json }
  }
  async commitContract() {
    // Expose the Git artifact for integration checks.
    return { head: await headSha(this.repo), parent: (await git(this.repo, ['rev-parse', '--short', 'HEAD~1'])).trim(), message: (await git(this.repo, ['log', '-1', '--format=%s'])).trim(),
      files: (await git(this.repo, ['show', '--format=', '--name-only', 'HEAD'])).trim().split('\n') }
  }
  async close() { await this.questions.idle(this.dir); await rm(this.repo, { recursive: true, force: true }) }
}
