import { executeOwnerDecision } from '../decision-commands.ts'
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ApplyService } from '../apply.ts'
import { worktreeId, listChanges } from '../discovery.ts'
import { decideDiscussion } from '../discussion-commands.ts'
import { observeAttempt, startLocalAttempt } from '../execution-receipts.ts'
import { git } from '../git.ts'
import { readReview, readReviewEvents, recordReviewEvents, REVIEW_FILE, ReviewSchema } from '../review-store.ts'
import { FINISHERS } from '../run-kinds.ts'
import { InitiativeRunService } from '../run-service.ts'
import { RunnerService } from '../runner.ts'
import { registerCorpusRoutes } from '../routes/corpus.ts'
import { registerApplyRoutes } from '../routes/apply.ts'
import { registerDecisionRoutes } from '../routes/decisions.ts'
import { registerInitiativeDecisionRoutes } from '../routes/initiative-decisions.ts'
import { registerInitiativeRoutes, type InitiativeRouteDeps } from '../routes/initiatives.ts'
import { registerRunnerRoutes } from '../routes/runner.ts'
import { registerThreadRoutes } from '../routes/threads.ts'
import { FAKE_CODEX, resetFakeCodex } from './fake-codex-path.ts'
import { FakeSandbox } from './fake-sandbox.ts'
import { call, callForm } from './http.ts'
import { ReviewWorld } from './review-world.ts'
import { writeFiles } from './repo.ts'
import { INITIATIVE_FILE, readInitiative } from '../initiative-store.ts'
import { readInitiativeStream } from '../initiative-events.ts'
import { readWorktreeStream } from '../worktree-events.ts'
import { prepareCreationFixture } from './creation-fixture.ts'
import { readVerificationStream, updateVerification } from '../verification-events.ts'
import { attemptDirectory } from '../execution-receipts.ts'
import type { Finishers } from '../run-service.ts'
import { prepareVerificationAttempt, prepareVerificationReceipt } from './verification-fixture.ts'
import { randomUUID } from 'node:crypto'
import { captureVerificationProfile } from '../verification-rerun.ts'

// One public-API adapter per domain. The CLI transport is scripted, not the application services.
export class DeskWorld {
  readonly vars: Record<string, unknown>
  private readonly savedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_')))
  private runs: InitiativeRunService
  private readonly sandbox = new FakeSandbox()
  private readonly initiativeDeps: InitiativeRouteDeps
  private readonly apply: ApplyService
  private runner: RunnerService
  private constructor(private readonly review: ReviewWorld) {
    this.vars = review.vars
    resetFakeCodex()
    process.env.FAKE_CODEX_MODE = 'answer'
    process.env.FAKE_CODEX_LOG = path.join(review.repo, '.spec-review/codex-calls.jsonl')
    process.env.FAKE_CODEX_SESSIONS = path.join(review.repo, '.spec-review/sessions')
    review.ctx.config.codexBin = FAKE_CODEX
    const sandbox = this.sandbox
    this.runs = new InitiativeRunService({ config: review.ctx.config, bus: review.ctx.bus, sandbox, finishers: FINISHERS })
    this.apply = new ApplyService({ config: review.ctx.config, bus: review.ctx.bus, pollMs: 10 })
    this.runner = new RunnerService({ profiles: [{ name: 'fixture', execution: 'local', worktreePath: review.repo,
      command: [process.execPath, 'verify.mjs'], watch: [], applyAllowedTools: [] }], bus: review.ctx.bus })
    registerThreadRoutes(review.app, review.ctx, { questions: review.questions, applyActive: p => this.apply.active(p), resumeApply: (wt, ref, id, text) => this.apply.resume(wt, ref, id, text) })
    registerDecisionRoutes(review.app, review.ctx, { questions: review.questions })
    this.initiativeDeps = { runs: this.runs, sandbox }
    registerInitiativeRoutes(review.app, review.ctx, this.initiativeDeps)
    registerInitiativeDecisionRoutes(review.app, review.ctx)
    registerApplyRoutes(review.app, review.ctx, { apply: this.apply })
    registerCorpusRoutes(review.app, review.ctx)
    registerRunnerRoutes(review.app, review.ctx, {
      profileFor: cwd => this.runner.profileFor(cwd), state: cwd => this.runner.state(cwd),
      refresh: cwd => this.runner.refresh(cwd), start: cwd => this.runner.start(cwd),
      runNow: (cwd, explicit) => this.runner.runNow(cwd, explicit), stop: cwd => this.runner.stop(cwd),
    })
  }
  static async create() {
    const review = await ReviewWorld.create()
    try { return new DeskWorld(review) }
    catch (error) { await review.close(); throw error }
  }
  get repo() { return this.review.repo }
  resolve(value: unknown): any { return this.review.resolve(value) }
  async ready() { const change = this.vars.change; await this.review.ready(); if (this.changeDir) this.vars.change = change; this.vars.runner = `/api/runner/${worktreeId(this.review.repo)}` }
  private changeDir = ''
  async events(stream: 'review' | 'initiative' | 'verification' | 'worktree' = 'review') {
    if (stream === 'review') return readReviewEvents(this.changeDir || this.review.dir)
    if (stream === 'verification') return (await readVerificationStream(this.repo)).events.map(({ event, ...envelope }) => ({ ...envelope, ...event }))
    if (stream === 'worktree') return (await readWorktreeStream(this.repo)).events.map(({ event, ...envelope }) => ({ ...envelope, ...event }))
    const root = path.join(this.repo, 'desk/initiatives')
    const names = await readdir(root).catch(() => [] as string[])
    if (names.length > 1) throw new Error('An initiative event observation must select one stream')
    if (!names[0]) return []
    return (await readInitiativeStream(path.join(root, names[0]))).events.map(({ event, ...envelope }) => ({ ...envelope, ...event }))
  }
  read(url: string) { return this.review.read(url) }
  private async setupCommand(name: string, data: Record<string, any>) {
    await this.ready()
    const r = await this.command(name, data)
    if (r.status >= 400) throw Error(`Given ${name}: ${JSON.stringify(r)}`)
    return r
  }
  private cliReply(reply: unknown) { process.env.FAKE_CODEX_REPLY = JSON.stringify(reply) }
  private replaceInitiativeService(finishers: Finishers = FINISHERS) {
    this.runs = new InitiativeRunService({ config: this.review.ctx.config, bus: this.review.ctx.bus, sandbox: this.sandbox, finishers })
    this.initiativeDeps.runs = this.runs
  }
  private async patch() {
    const file = path.join(this.review.dir, 'features/subject.desk.yaml')
    const original = await readFile(file, 'utf8')
    await writeFile(file, '# Owner decision 2026-10-02: respond with the revised status.\n' + original.replace('status: 200', 'status: 201'))
    const diff = await git(this.review.repo, ['diff', '--', file])
    await writeFile(file, original)
    return diff
  }
  async given(name: string, data: Record<string, any>) {
    if (name === 'InitiativeCreationPrepared') {
      const { state } = await prepareCreationFixture(this.review.ctx.config, data.phase ?? 'requested', data)
      this.vars.creation = state.request.id; this.vars.creationName = state.request.name
      this.vars.creationWorktree = worktreeId(state.request.targetPath)
      return
    }
    if (name === 'CreationSourceChanged') { await writeFiles(this.repo, { 'README.md': 'Changed after the creation request\n' }); return }
    if (['QuestionReceiptAwaitingRecovery', 'QuestionAttemptOutcomeUnknown', 'QuestionOutcomeUncertain', 'QuestionRecovered'].includes(name)) {
      await this.ready()
      const wt = this.review.ctx.registry.all()[0]!
      const ref = (await listChanges(wt)).find(ref => ref.dir === this.review.dir)!
      this.vars.thread = 't_recovery'
      await recordReviewEvents(ref.dir, async doc => ({ events: decideDiscussion(doc, { type: 'OpenDiscussion', thread: {
        id: String(this.vars.thread), anchor: 'scenario', ref: String(this.vars.key), status: 'open', messages: [
          { role: 'owner', at: String(this.vars.at), text: 'Explain the recovered contract.', note: null, patch: null },
        ],
      } }) }), 'fixture')
      const run = (await readReview(ref.dir)).executions.at(-1)!
      this.vars.questionRun = run.request.id
      const attempt = await this.review.questions.prepareAttempt(wt, ref, run, 'initial')
      await recordReviewEvents(ref.dir, async () => ({ events: [{ type: 'ExecutionAttemptRequested', runId: run.request.id, attempt }] }), 'fixture')
      if (name === 'QuestionReceiptAwaitingRecovery' || name === 'QuestionRecovered') {
        await startLocalAttempt(attempt, 5000, { FAKE_CODEX_REPLY: JSON.stringify({ answer: 'The durable answer is recovered once.', patch: null, decisions: [], resolves: [], status: 'answered' }) })
        for (let i = 0; ; i++) {
          const observed = await observeAttempt(wt.path, attempt.id)
          if (observed.kind === 'receipt') break
          if (observed.kind !== 'live' || i >= 200) throw new Error('Fixture execution did not produce a terminal receipt')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      if (name === 'QuestionOutcomeUncertain' || name === 'QuestionRecovered') await this.review.questions.recover(wt, ref)
    } else if (name === 'ApplyRunning' || name === 'ApplyStopped') {
      await this.ready()
      process.env.FAKE_CODEX_MODE = 'hang'
      const response = await call(this.review.app, 'POST', `${this.vars.change}/apply`)
      if (response.status !== 202) throw new Error(`Cannot prepare running Apply: ${JSON.stringify(response.json)}`)
      this.vars.applyRun = response.json.run.id
      process.env.FAKE_CODEX_MODE = 'answer'
      if (name === 'ApplyStopped') await this.setupCommand('StopApply', {})
    } else if (name === 'DiscussionAnswered') {
      this.review.agentUsageReported = data.usageReported !== false
      this.review.agentReply = { answer: data.answer ?? 'Noted.', patch: data.patch ? await this.patch() : null, decisions: [], resolves: data.resolves ?? [], status: 'answered' }
      const r = await this.setupCommand('OpenDiscussion', { anchor: 'scenario', ref: this.vars.key, text: data.text ?? 'Explain the contract.' })
      this.vars.thread = r.body.id
    } else if (name === 'DiscussionClosed') {
      await this.setupCommand('ResolveDiscussion', { thread: this.vars.thread })
    } else if (name === 'ReviewProjectionUnavailable') {
      await rm(path.join(this.changeDir || this.review.dir, REVIEW_FILE), { force: true })
      await rm(path.join(this.changeDir || this.review.dir, 'decisions.md'), { force: true })
    } else if (name === 'GitCommitUnavailable' || name === 'GitCommitAvailable') {
      const hooks = (await git(this.review.repo, ['rev-parse', '--git-path', 'hooks/pre-commit'])).trim()
      const hook = path.resolve(this.review.repo, hooks)
      if (name === 'GitCommitUnavailable') { await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755) }
      else await rm(hook, { force: true })
    } else if (name === 'OwnerChoiceRecorded') {
      const response = await this.setupCommand('DecideOwnerQuestion', { id: this.vars.decision, option: data.option, note: data.note })
      this.vars.recordedCommit = response.body.commit
    } else if (name === 'OwnerChoiceRecordingPending') {
      await this.given('GitCommitUnavailable', {})
      await this.ready()
      const response = await this.command('DecideOwnerQuestion', { id: this.vars.decision, option: data.option, note: data.note })
      if (response.status !== 500) throw Error('Given pending decision requires a failed commit')
    } else if (name === 'OwnerDecisionReattached') {
      await this.setupCommand('ReattachOwnerQuestion', { id: this.vars.decision, to: data.to })
    } else if (name === 'AgentReplyPrepared') {
      this.review.agentReply = { answer: data.answer ?? 'Noted.', patch: data.patch ? await this.patch() : null, decisions: data.decisions ?? [], resolves: data.resolves ?? [], status: 'answered' }
    } else if (name === 'InitiativeOpened') {
      const r = await this.setupCommand('OpenInitiative', data)
      this.vars.initiative = `/api/initiatives/${r.body.worktreeId}/${r.body.name}`
      this.vars.initiativeName = r.body.name
      this.vars.initiativeDir = path.join(this.review.repo, 'desk/initiatives', r.body.name)
    } else if (name === 'InitiativeBriefCommitPending') {
      await this.given('GitCommitUnavailable',{})
      const result=await this.command('EditBrief',{brief:'Pending owner brief.'})
      if(result.status!==409)throw new Error('Expected an interrupted initiative commit')
      this.vars.initiativeEffect=(await readInitiative(String(this.vars.initiativeDir))).git_effects.at(-1)!.plan.effectId
    } else if (name === 'InitiativeBriefCommitUnacknowledged') {
      await this.setupCommand('EditBrief',{brief:'Committed owner brief.'})
      const dir=String(this.vars.initiativeDir),stream=await readInitiativeStream(dir)
      if(stream.events.at(-1)?.event.type!=='InitiativeOwnerGitCompleted')throw new Error('Fixture requires a committed owner effect')
      // Disposable fixture: simulate the consumer dying between Git success and receipt append.
      await writeFile(path.join(dir,'initiative.events.jsonl'),stream.events.slice(0,-1).map(event=>JSON.stringify(event)+'\n').join(''))
    } else if (name === 'ResearchDomainsAllowed') {
      await this.setupCommand('SetResearchDomains', { domains: data.domains })
    } else if (name === 'InitiativeProjectionUnavailable') {
      const dir = String(this.vars.initiativeDir)
      const doc = await readInitiative(dir)
      await rm(path.join(dir, INITIATIVE_FILE), { force: true })
      await rm(path.join(dir, 'brief.md'), { force: true })
      for (const input of doc.inputs) await rm(path.join(dir, 'inputs', input.file), { force: true })
    } else if (name === 'PlanDrafted') {
      this.cliReply({ answer: 'Plan ready.', patch: null, decisions: [], resolves: [], status: 'done', slices: data.slices })
      await this.setupCommand('RunPlanner', {})
    } else if (name === 'PlannerReplyPrepared') this.cliReply({ answer: 'Plan ready.', patch: null, decisions: [], resolves: [], status: 'done', slices: data.slices })
    else if (name === 'InitiativeDecisionRaised') {
      const decisions = ReviewSchema.parse({ version: 1, decisions: [{ id: 'd_fixture', source: { kind: 'owner' }, scope: { kind: 'change' }, question: 'Owner choice?', blocking: true, status: 'open', created_at: this.vars.at }] }).decisions
      await executeOwnerDecision(String(this.vars.initiativeDir), { type: 'RaiseOwnerDecisions', decisions }, 'fixture')
    } else if (name === 'ScenarioDecisionChosen') {
      const r = await this.setupCommand('DecideOwnerQuestion', { id: this.vars.decision, option: data.option, note: data.note })
      this.vars.thread = r.body.threadId
    } else if (name === 'ApprovedSliceProposed') {
      await this.given('AuthorOutputPrepared', data)
      await this.setupCommand('ProposeSlice', { slice: 's1', change: data.change ?? 'slice-contract' })
      this.vars.change = `/api/changes/${worktreeId(this.review.repo)}/${data.change ?? 'slice-contract'}`
      this.changeDir = path.join(this.review.repo, 'desk/changes', data.change ?? 'slice-contract')
      await this.setupCommand('ApproveScenario', { key: this.vars.key })
      await this.setupCommand('RecordChangeApproval', {})
    } else if (name === 'ApplyWaitingOnOwner') {
      this.cliReply({ answer: 'Owner choice required.', patch: null, resolves: [], status: 'needs_owner', decisions: [{ id: 'flag', question: 'Ship behind a flag?', scope: { kind: 'change' }, blocking: true, options: [{ id: 'yes', label: 'Yes', consequence: 'Use a flag.' }, { id: 'no', label: 'No', consequence: 'Ship directly.' }], recommended: 'yes' }] })
      const r = await this.setupCommand('StartApply', {})
      this.vars.applyRun = r.body.run.id
      this.vars.decision = (await readReview(this.changeDir || this.review.dir)).decisions.at(-1)!.id
    } else if (name === 'ApplyDecisionRecorded') await this.setupCommand('DecideOwnerQuestion', { id: this.vars.decision, option: 'yes' })
    else if (name === 'PlanApproved') await this.setupCommand('ApprovePlan', {})
    else if (name === 'PlannerResultRecorded') {
      this.replaceInitiativeService({ ...FINISHERS, planner: async () => {} })
      this.cliReply({ answer: 'Plan ready.', patch: null, decisions: [], resolves: [], status: 'done', slices: [{ title: 'Agent plan', scope: 'Agent proposal.', depends_on: [] }] })
      await this.setupCommand('RunPlanner', {})
      this.replaceInitiativeService()
    } else if (name === 'OwnerPlanRevised') {
      await this.setupCommand('EditPlan', { slices: [{ id: null, title: 'Owner plan', scope: 'Owner revision.', depends_on: [] }] })
    } else if (name === 'ResearchResultRecorded') {
      // A completed transport receipt whose consumer exited before applying its domain result.
      this.replaceInitiativeService({ ...FINISHERS, research: async () => {} })
      this.cliReply({ answer: 'Research ready.', patch: null, decisions: [], resolves: [], status: 'done', document: '# Findings\n\n## Sources\n- https://example.com\n' })
      const result = await this.setupCommand('RunResearch', { topic: 'Contract', questions: 'What is known?' })
      this.vars.researchRun = result.body.run.id
      this.replaceInitiativeService()
    } else if (name === 'InitiativeReceiptUnavailable') {
      const doc = await readInitiative(String(this.vars.initiativeDir))
      const run = doc.runs.find(run => run.id === this.vars.researchRun)!
      const attempt = doc.executions.find(item => item.request.id === run.execution_id)!.attempts.at(-1)!
      await rm(path.join(attemptDirectory(this.repo, attempt.id), 'receipt.json'), { force: true })
      await rm(path.join(attemptDirectory(this.repo, attempt.id), 'result.ndjson'), { force: true })
    } else if (name === 'ResearchOutcomeUnknown') {
      await this.given('ResearchResultRecorded', {})
      await this.given('InitiativeReceiptUnavailable', {})
      await this.setupCommand('ReconcileInitiativeRuns', {})
    } else if (name === 'ResearchDrafted') {
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
      const rel = `desk/changes/${data.change ?? 'slice-contract'}`
      await writeFile(path.join(this.review.repo, '.spec-review/author-writes.json'), JSON.stringify([{ match: 'Slice', files: {
        [`${rel}/change.yaml`]: 'version: 1\nkind: behavior-driven\n', [`${rel}/proposal.md`]: '## Why\n\nReview the contract.\n',
        [`${rel}/features/subject.desk.yaml`]: source,
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
    } else if (name === 'VerificationCompleted') await this.setupCommand('RunVerification', {})
    else if (name === 'VerificationOutcomeUncertain') {
      const { runId, attempt } = await prepareVerificationAttempt(this.review.repo)
      await updateVerification(this.review.repo, () => ({ events: [{ type: 'ExecutionUncertain', runId, attemptId: attempt.id, reason: 'The previous verification outcome cannot be proved' }], value: undefined }))
    }
    else if (name === 'VerificationReceiptAvailable') await prepareVerificationReceipt(this.review.repo)
    else if (name === 'VerificationRerunPending') {
      const run = (await readVerificationStream(this.repo)).projection.runs.at(-1)!
      const profile = this.runner.profileFor(this.repo)!
      this.vars.previousVerification = run.request.id
      this.vars.verificationRerun = randomUUID()
      await updateVerification(this.repo, () => ({ events: [{ type: 'VerificationRerunRequested', request: {
        id: String(this.vars.verificationRerun), afterRunId: run.request.id, at: new Date().toISOString(), profile: captureVerificationProfile(profile),
      } }], value: undefined }))
    }
    else if (name === 'VerificationProjectionLost') await rm(path.join(this.review.repo, '.spec-review/verification.json'), { force: true })
    else if (name === 'VerificationSourceChanged') await writeFiles(this.review.repo, { 'README.md': 'Changed verification input\n' })
    else if (name === 'VerificationPrepared') {
      const status = data.status ?? 'passed'
      const mode = data.mode ?? 'complete'
      const source = await readFile(path.join(this.changeDir || this.review.dir, 'features/subject.desk.yaml'), 'utf8')
      await writeFiles(this.review.repo, { 'features/subject.desk.yaml': source,
        'verify.mjs': `import {writeFile} from 'node:fs/promises'; const env=process.env; const messages=[{deskScenarioResult:{key:'subject.desk.yaml::subject',status:${JSON.stringify(status)},message:null,row:null,rows:null}},{deskRunFinished:{at:new Date().toISOString(),runId:env.DESK_RUN_ID,attemptId:env.DESK_ATTEMPT_ID,sourceHash:env.DESK_SOURCE_HASH}}]; const mode=${JSON.stringify(mode)}; if(mode==='incomplete')messages.pop(); if(mode==='foreign')messages[1].deskRunFinished.sourceHash='0'.repeat(64); if(mode==='duplicate')messages.splice(1,0,messages[0]); await writeFile(env.DESK_RESULT_FILE,messages.map(m=>JSON.stringify(m)).join('\\n')+'\\n',{flag:'wx'}); process.exit(${status === 'failed' ? 1 : 0});\n` })
    } else await this.review.given(name, data)
  }
  async command(name: string, data: Record<string, any>) {
    if (name === 'RestartVerification') {
      this.runner = new RunnerService({ profiles: [{ name: 'fixture', execution: 'local', worktreePath: this.review.repo,
        command: [process.execPath, 'verify.mjs'], watch: [], applyAllowedTools: [] }], bus: this.review.ctx.bus })
      await this.runner.loadLast(this.review.repo)
      await this.runner.idle(this.review.repo)
      return this.read(String(this.vars.runner))
    }
    if (name === 'InspectVerification') return this.read(String(this.vars.runner))
    const base = String(this.vars.change), ini = String(this.vars.initiative)
    if(name==='UploadInitiativeInputs') {
      const form=new FormData()
      for(const file of data.files)form.append('files',new File([file.text],file.name))
      const result=await callForm(this.review.app,`${ini}/inputs`,form)
      return {status:result.status,body:result.json}
    }
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
      ReattachOwnerQuestion: ['POST', `${base}/decisions/${data.id}/reattach`, { to: data.to }],
      DismissOwnerQuestion: ['POST', `${base}/decisions/${data.id}/dismiss`, { reason: data.reason }],
      ObserveInitiative: ['GET', ini], EditPlan: ['PUT', `${ini}/plan`, { slices: data.slices }], SetResearchDomains: ['PUT', `${ini}/research/domains`, { domains: data.domains }], DiscardResearch: ['POST', `${ini}/inputs/${data.file}/discard`],
      EditBrief: ['PUT', `${ini}/brief`, { brief: data.brief }], RunPlanner: ['POST', `${ini}/plan/run`], ApprovePlan: ['POST', `${ini}/plan/approve`],
      ProposeSlice: ['POST', `${ini}/slices/${data.slice}/propose`, { change: data.change }],
      RunResearch: ['POST', `${ini}/research`, data], DecideResearchPermission: ['POST', `${ini}/decisions/${data.id}/decide`, { option: data.option }], ResumeResearch: ['POST', `${ini}/runs/${data.run}/resume`, {}], AcceptResearch: ['POST', `${ini}/inputs/${data.file}/accept`],
      RetryInitiativeCommit: ['POST', `${ini}/effects/${data.effect}/retry`],
      ReconcileInitiativeRuns: ['POST', `${ini}/runs/reconcile`], StopResearch: ['POST', `${ini}/runs/${data.run}/stop`],
      StartApply: ['POST', `${base}/apply`], ReapplyContract: ['POST', `${base}/reapply`], ResumeApply: ['POST', `${base}/apply/resume`, { runId: data.run }], RunVerification: ['POST', `${this.vars.runner}/run`], StopVerification: ['POST', `${this.vars.runner}/stop`],
      StopApply: ['POST', `${base}/apply/stop`], RecoverExecutions: ['POST', `${base}/executions/recover`],
      ResumeQuestion: ['POST', `${base}/executions/${data.run}/resume`],
      RecoverInitiativeCreations: ['POST', '/api/initiative-creations/api/recover'],
      RetryInitiativeCreation: ['POST', `/api/initiative-creations/api/${data.id}/retry`],
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
    if (name === 'StopResearch') await this.runs.settled(data.run)
    if (name === 'ResumeApply') await this.apply.settled(data.run)
    if (name === 'StopApply') await this.apply.settled(String(this.vars.applyRun))
    if (name === 'ResumeQuestion') await this.review.questions.settled(data.run)
    if (name === 'RunVerification' || name === 'StopVerification') await this.runner.idle(this.review.repo)
    return { status: r.status, body: r.json }
  }
  async close() {
    try {
      const doc = await readReview(this.changeDir || this.review.dir)
      for (const run of doc.apply_runs.filter(run => run.outcome === 'running')) {
        const wt = this.review.ctx.registry.all()[0]!
        const ref = (await listChanges(wt)).find(ref => ref.dir === (this.changeDir || this.review.dir))!
        await this.apply.stop(wt, ref)
        await this.apply.settled(run.id)
      }
      await this.runner.idle(this.review.repo)
      await this.review.close()
    } finally {
      for (const k of Object.keys(process.env).filter(k => k.startsWith('FAKE_'))) delete process.env[k]
      Object.assign(process.env, this.savedEnv)
    }
  }
}
