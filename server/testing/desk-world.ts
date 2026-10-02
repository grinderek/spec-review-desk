import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ApplyService } from '../apply.ts'
import { worktreeId } from '../discovery.ts'
import { git } from '../git.ts'
import { readReview, readReviewEvents, ReviewSchema, updateReview } from '../review-store.ts'
import { FINISHERS } from '../run-kinds.ts'
import { InitiativeRunService } from '../run-service.ts'
import { RunnerService } from '../runner.ts'
import { registerCorpusRoutes } from '../routes/corpus.ts'
import { registerApplyRoutes } from '../routes/apply.ts'
import { registerDecisionRoutes } from '../routes/decisions.ts'
import { registerInitiativeDecisionRoutes } from '../routes/initiative-decisions.ts'
import { registerInitiativeRoutes } from '../routes/initiatives.ts'
import { registerRunnerRoutes } from '../routes/runner.ts'
import { registerThreadRoutes } from '../routes/threads.ts'
import { FAKE_CODEX, FAKE_OPENSPEC, resetFakeCodex } from './fake-codex-path.ts'
import { FakeSandbox } from './fake-sandbox.ts'
import { call, callForm } from './http.ts'
import { ReviewWorld } from './review-world.ts'
import { writeFiles } from './repo.ts'

// One public-API adapter per domain. The CLI transport is scripted, not the application services.
export class DeskWorld {
  readonly vars: Record<string, unknown>
  private readonly savedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_')))
  private readonly runs: InitiativeRunService
  private readonly apply: ApplyService
  private readonly runner: RunnerService
  private constructor(private readonly review: ReviewWorld) {
    this.vars = review.vars
    resetFakeCodex()
    process.env.FAKE_CODEX_MODE = 'answer'
    process.env.FAKE_CODEX_LOG = path.join(review.repo, '.spec-review/codex-calls.jsonl')
    process.env.FAKE_CODEX_SESSIONS = path.join(review.repo, '.spec-review/sessions')
    review.ctx.config.codexBin = FAKE_CODEX
    review.ctx.config.openspecBin = FAKE_OPENSPEC
    const sandbox = new FakeSandbox()
    this.runs = new InitiativeRunService({ config: review.ctx.config, bus: review.ctx.bus, sandbox, finishers: FINISHERS })
    this.apply = new ApplyService({ config: review.ctx.config, bus: review.ctx.bus, pollMs: 10 })
    this.runner = new RunnerService({ profiles: [{ name: 'fixture', execution: 'local', worktreePath: review.repo,
      command: [process.execPath, 'verify.mjs'], watch: [], applyAllowedTools: [] }], bus: review.ctx.bus })
    registerThreadRoutes(review.app, review.ctx, { questions: review.questions, applyActive: p => this.apply.active(p), resumeApply: (wt, ref, id) => this.apply.resume(wt, ref, id) })
    registerDecisionRoutes(review.app, review.ctx, { questions: review.questions })
    registerInitiativeRoutes(review.app, review.ctx, { runs: this.runs, sandbox })
    registerInitiativeDecisionRoutes(review.app, review.ctx)
    registerApplyRoutes(review.app, review.ctx, { apply: this.apply })
    registerCorpusRoutes(review.app, review.ctx)
    registerRunnerRoutes(review.app, review.ctx, this.runner)
  }
  static async create() { return new DeskWorld(await ReviewWorld.create()) }
  get repo() { return this.review.repo }
  resolve(value: unknown): any { return this.review.resolve(value) }
  async ready() { const change = this.vars.change; await this.review.ready(); if (this.changeDir) this.vars.change = change; this.vars.runner = `/api/runner/${worktreeId(this.review.repo)}` }
  private changeDir = ''
  events() { return readReviewEvents(this.changeDir || this.review.dir) }
  read(url: string) { return this.review.read(url) }
  private async setupCommand(name: string, data: Record<string, any>) {
    await this.ready()
    const r = await this.command(name, data)
    if (r.status >= 400) throw Error(`Given ${name}: ${JSON.stringify(r)}`)
    return r
  }
  private cliReply(reply: unknown) { process.env.FAKE_CODEX_REPLY = JSON.stringify(reply) }
  private async patch() {
    const file = path.join(this.review.dir, 'features/subject.desk.yaml')
    const original = await readFile(file, 'utf8')
    await writeFile(file, '# Owner decision 2026-10-02: respond with the revised status.\n' + original.replace('status: 200', 'status: 201'))
    const diff = await git(this.review.repo, ['diff', '--', file])
    await writeFile(file, original)
    return diff
  }
  async given(name: string, data: Record<string, any>) {
    if (name === 'DiscussionAnswered') {
      this.review.agentReply = { answer: data.answer ?? 'Noted.', patch: data.patch ? await this.patch() : null, decisions: [], resolves: data.resolves ?? [], status: 'answered' }
      const r = await this.setupCommand('OpenDiscussion', { anchor: 'scenario', ref: this.vars.key, text: data.text ?? 'Explain the contract.' })
      this.vars.thread = r.body.id
    } else if (name === 'AgentReplyPrepared') {
      this.review.agentReply = { answer: data.answer ?? 'Noted.', patch: data.patch ? await this.patch() : null, decisions: data.decisions ?? [], resolves: data.resolves ?? [], status: 'answered' }
    } else if (name === 'InitiativeOpened') {
      const r = await this.setupCommand('OpenInitiative', data)
      this.vars.initiative = `/api/initiatives/${r.body.worktreeId}/${r.body.name}`
      this.vars.initiativeName = r.body.name
      this.vars.initiativeDir = path.join(this.review.repo, 'openspec/initiatives', r.body.name)
    } else if (name === 'PlanDrafted') {
      this.cliReply({ answer: 'Plan ready.', patch: null, decisions: [], resolves: [], status: 'done', slices: data.slices })
      await this.setupCommand('RunPlanner', {})
    } else if (name === 'PlannerReplyPrepared') this.cliReply({ answer: 'Plan ready.', patch: null, decisions: [], resolves: [], status: 'done', slices: data.slices })
    else if (name === 'InitiativeDecisionRaised') {
      const decisions = ReviewSchema.parse({ version: 1, decisions: [{ id: 'd_fixture', source: { kind: 'owner' }, scope: { kind: 'change' }, question: 'Owner choice?', blocking: true, status: 'open', created_at: this.vars.at }] }).decisions
      await updateReview(String(this.vars.initiativeDir), doc => ({ ...doc, decisions }))
    } else if (name === 'ScenarioDecisionChosen') {
      const r = await this.setupCommand('DecideOwnerQuestion', { id: this.vars.decision, option: data.option, note: data.note })
      this.vars.thread = r.body.threadId
    } else if (name === 'ApprovedSliceProposed') {
      await this.given('AuthorOutputPrepared', data)
      await this.setupCommand('ProposeSlice', { slice: 's1', change: data.change ?? 'slice-contract' })
      this.vars.change = `/api/changes/${worktreeId(this.review.repo)}/${data.change ?? 'slice-contract'}`
      this.changeDir = path.join(this.review.repo, 'openspec/changes', data.change ?? 'slice-contract')
      await this.setupCommand('ApproveScenario', { key: this.vars.key })
      await this.setupCommand('RecordChangeApproval', {})
    } else if (name === 'ApplyWaitingOnOwner') {
      this.cliReply({ answer: 'Owner choice required.', patch: null, resolves: [], status: 'needs_owner', decisions: [{ id: 'flag', question: 'Ship behind a flag?', scope: { kind: 'change' }, blocking: true, options: [{ id: 'yes', label: 'Yes', consequence: 'Use a flag.' }, { id: 'no', label: 'No', consequence: 'Ship directly.' }], recommended: 'yes' }] })
      const r = await this.setupCommand('StartApply', {})
      this.vars.applyRun = r.body.run.id
      this.vars.decision = (await readReview(this.changeDir || this.review.dir)).decisions.at(-1)!.id
    } else if (name === 'ApplyDecisionRecorded') await this.setupCommand('DecideOwnerQuestion', { id: this.vars.decision, option: 'yes' })
    else if (name === 'PlanApproved') await this.setupCommand('ApprovePlan', {})
    else if (name === 'ResearchDrafted') {
      this.cliReply({ answer: 'Research ready.', patch: null, decisions: [], resolves: [], status: 'done', document: data.document ?? '# Findings\n\n## Sources\n- https://example.com\n' })
      await this.setupCommand('RunResearch', { topic: data.topic ?? 'Contract', questions: 'What is known?' })
    } else if (name === 'ResearchWaitingForDomains') {
      this.cliReply({ answer: 'Permission required.', patch: null, resolves: [], status: 'needs_owner', document: '', decisions: [{ id: 'fetch-domains', question: 'Read the contract documentation?', scope: { kind: 'change' }, blocking: true, requested_domains: ['docs.example.com'], recommended: 'allow_all', options: ['allow_all', 'allow_some', 'search_only'].map(id => ({ id, label: id, consequence: id })) }] })
      const r = await this.setupCommand('RunResearch', { topic: 'Contract', questions: 'What is known?' })
      this.vars.researchRun = r.body.run.id
      this.vars.researchDecision = (await readReview(String(this.vars.initiativeDir))).decisions.at(-1)!.id
    } else if (name === 'ResearchPermissionRecorded') await this.setupCommand('DecideResearchPermission', { id: this.vars.researchDecision, option: data.choice })
    else if (name === 'ResearchReplyPrepared') this.cliReply({ answer: 'Research ready.', patch: null, decisions: [], resolves: [], status: 'done', document: '# Findings\n\n## Sources\n- https://docs.example.com\n' })
    else if (name === 'AuthorOutputPrepared') {
      const source = await readFile(path.join(this.review.dir, 'features/subject.desk.yaml'), 'utf8')
      this.cliReply({ answer: 'Change ready.', patch: null, decisions: [], resolves: [], status: 'done', change: data.change ?? 'slice-contract' })
      const rel = `openspec/changes/${data.change ?? 'slice-contract'}`
      await writeFile(path.join(this.review.repo, '.spec-review/author-writes.json'), JSON.stringify([{ match: 'Slice', files: {
        [`${rel}/.openspec.yaml`]: 'schema: behavior-driven\n', [`${rel}/proposal.md`]: '## Why\n\nReview the contract.\n',
        [`${rel}/features/subject.desk.yaml`]: source, [`${rel}/specs/subject/spec.md`]: '#### Scenario: Subject contract\n',
      } }]))
      process.env.FAKE_CODEX_WRITES_FILE = path.join(this.review.repo, '.spec-review/author-writes.json')
    } else if (name === 'ApplyReplyPrepared') {
      this.cliReply({ answer: data.answer ?? 'Done.', patch: null, decisions: data.decisions ?? [], resolves: [], status: data.status ?? 'done' })
      if (data.deliver === false) delete process.env.FAKE_CODEX_WRITES_FILE
      else {
        const source = await readFile(path.join(this.changeDir || this.review.dir, 'features/subject.desk.yaml'), 'utf8')
        const script = path.join(this.review.repo, '.spec-review/apply-writes.json')
        await writeFiles(this.review.repo, { '.spec-review/apply-writes.json': JSON.stringify([{ match: '', files: { 'features/subject.desk.yaml': source } }]) })
        process.env.FAKE_CODEX_WRITES_FILE = script
      }
    }
    else if (name === 'ChangeApprovalRecorded') await this.setupCommand('RecordChangeApproval', {})
    else if (name === 'CorpusDrifted') {
      const source = await readFile(path.join(this.changeDir || this.review.dir, 'features/subject.desk.yaml'), 'utf8')
      await writeFiles(this.review.repo, { 'features/subject.desk.yaml': source.replace('status: 200', 'status: 201') })
    } else if (name === 'VerificationPrepared') {
      const status = data.status ?? 'passed'
      const messages = [{ deskScenarioResult: { key: 'subject.desk.yaml::Subject contract', status } }, { deskRunFinished: { at: String(this.vars.at) } }]
      await writeFiles(this.review.repo, { 'verify.mjs': `import {mkdir,writeFile} from 'node:fs/promises'; await mkdir('.spec-review',{recursive:true}); await writeFile('.spec-review/last-run.ndjson', ${JSON.stringify(messages.map(m => JSON.stringify(m)).join('\n'))}); process.exit(${status === 'failed' ? 1 : 0});\n` })
    } else await this.review.given(name, data)
  }
  async command(name: string, data: Record<string, any>) {
    const base = String(this.vars.change), ini = String(this.vars.initiative)
    if (name === 'OpenInitiative') {
      const form = new FormData()
      for (const [k, v] of Object.entries({ name: data.name ?? 'hs', title: data.title ?? 'Health score', brief: data.brief ?? '# Brief\n', repo: 'api', where: 'existing', worktreeId: worktreeId(this.review.repo) })) form.set(k, String(v))
      const r = await callForm(this.review.app, '/api/initiatives', form)
      return { status: r.status, body: r.json }
    }
    const routes: Record<string, [string, string, unknown?]> = {
      OpenDiscussion: ['POST', `${base}/threads`, data], ReplyToDiscussion: ['POST', `${base}/threads/${data.thread}/messages`, { text: data.text }],
      ResolveDiscussion: ['POST', `${base}/threads/${data.thread}/resolve`], ApplyReviewPatch: ['POST', `${base}/threads/${data.thread}/patches/1/apply`, { summary: data.summary }],
      DecideOwnerQuestion: ['POST', `${base}/decisions/${data.id}/decide`, { option: data.option, note: data.note }],
      DismissOwnerQuestion: ['POST', `${base}/decisions/${data.id}/dismiss`, { reason: data.reason }],
      EditBrief: ['PUT', `${ini}/brief`, { brief: data.brief }], RunPlanner: ['POST', `${ini}/plan/run`], ApprovePlan: ['POST', `${ini}/plan/approve`],
      ProposeSlice: ['POST', `${ini}/slices/${data.slice}/propose`, { change: data.change }],
      RunResearch: ['POST', `${ini}/research`, data], DecideResearchPermission: ['POST', `${ini}/decisions/${data.id}/decide`, { option: data.option }], ResumeResearch: ['POST', `${ini}/runs/${data.run}/resume`, {}], AcceptResearch: ['POST', `${ini}/inputs/${data.file}/accept`],
      StartApply: ['POST', `${base}/apply`], ReapplyContract: ['POST', `${base}/reapply`], ResumeApply: ['POST', `${base}/apply/resume`, { runId: data.run }], RunVerification: ['POST', `${this.vars.runner}/run`],
    }
    const route = routes[name]
    if (!route) return this.review.command(name, data)
    const r = await call(this.review.app, route[0], route[1], route[2])
    await this.review.questions.idle(this.review.dir)
    if (r.json.run?.id) {
      if (name === 'StartApply' || name === 'ReapplyContract') await this.apply.settled(r.json.run.id)
      else await this.runs.settled(r.json.run.id)
    }
    if (name === 'ResumeResearch') await this.runs.settled(data.run)
    if (name === 'ResumeApply') await this.apply.settled(data.run)
    if (name === 'RunVerification') await this.runner.idle(this.review.repo)
    return { status: r.status, body: r.json }
  }
  async close() {
    try {
      await this.runner.idle(this.review.repo)
      await this.review.close()
    } finally {
      for (const k of Object.keys(process.env).filter(k => k.startsWith('FAKE_'))) delete process.env[k]
      Object.assign(process.env, this.savedEnv)
    }
  }
}
