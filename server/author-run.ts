import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readInitiativeStream } from './initiative-events.ts'
import { raiseRunDecisions, runGitEffect } from './initiative-finalization.ts'
import { executeOwnerDecision } from './decision-commands.ts'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { decisionsFromReply } from './decision-model.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { initiativeCommitMessage } from './initiative-git.ts'
import { authorPrompt } from './initiative-prompt.ts'
import { CHANGE_NAME, findSlice, type InitiativeDoc, readInitiative, withInitiativeLock, type RunRecord } from './initiative-store.ts'
import { sliceStatuses } from './initiatives.ts'
import { buildResumePrompt } from './prompt.ts'
import { readReview } from './review-store.ts'
import type { Finisher, InitiativeRunService, RunTarget } from './run-service.ts'
import { proposeBlocker } from './slice-plan.ts'
import { moveChange, vetAuthorOutput } from './vet-output.ts'
import { executeInitiativeCommand } from './initiative-commands.ts'

// Spec B §4.4: a clean-room author writes one slice as a behavior-driven change.
export { CHANGE_NAME } from './initiative-store.ts'

// Shortens a slug to `max` characters at a word (hyphen) boundary; only a single word longer than
// `max` is cut inside the word (Desk fixes item 5: "…-nameless-quickbo").
export function cutAtWord(slug: string, max: number): string {
  if (slug.length <= max) return slug
  const head = slug.slice(0, max)
  if (slug[max] === '-') return head.replace(/-+$/, '')
  const boundary = head.lastIndexOf('-')
  return (boundary > 0 ? head.slice(0, boundary) : head).replace(/-+$/, '')
}

export const slugify = (text: string): string =>
  cutAtWord(text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''), 40)

async function changeNames(wt: WorktreeInfo): Promise<string[]> {
  const root = path.join(wt.path, 'openspec', 'changes')
  const active = await readdir(root).catch(() => [] as string[])
  const archived = await readdir(path.join(root, 'archive')).catch(() => [] as string[])
  return [...active, ...archived.map((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, ''))]
}

// add-<initiative>-<slice title slug>, unique in the worktree (-2, -3, … on a clash).
export async function defaultChangeName(wt: WorktreeInfo, initiative: string, title: string): Promise<string> {
  const taken = new Set(await changeNames(wt))
  // The title gets what the prefix leaves of 60 characters (at least 14: an initiative name has at
  // most 41), cut at a word — or inside a first word longer than that — never dropped whole.
  const prefix = `add-${initiative}-`
  const base = `${prefix}${cutAtWord(slugify(title) || 'slice', 60 - prefix.length)}`
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function authorRunning(doc: InitiativeDoc): void {
  if (doc.runs.some((r) => r.kind === 'author' && ['running','queued','uncertain','needs_owner'].includes(r.outcome))) {
    throw new HttpError(409, 'author_running', 'An author run of this initiative is already running')
  }
}

export function startAuthor(
  service: InitiativeRunService,
  target: RunTarget,
  sliceId: string,
  input: { notes?: string; change?: string },
): Promise<RunRecord> {
  const busy = new HttpError(409, 'author_running', 'An author run of this initiative is already starting')
  return service.exclusive(`${target.ini.dir}#author`, busy, () => launchAuthor(service, target, sliceId, input))
}

async function launchAuthor(service: InitiativeRunService, target: RunTarget, sliceId: string, input: { notes?: string; change?: string }): Promise<RunRecord> {
  const doc = await readInitiative(target.ini.dir)
  if (doc.plan.status !== 'approved') throw new HttpError(409, 'plan_not_approved', 'Approve the slice plan before proposing a slice')
  const slice = findSlice(doc, sliceId)
  const blocker = proposeBlocker(doc.plan.slices, await sliceStatuses(target.wt, doc), sliceId)
  if (blocker) throw new HttpError(409, 'slice_not_ready', `${sliceId} cannot be proposed: ${blocker}`)
  authorRunning(doc)
  const change = input.change?.trim() || (await defaultChangeName(target.wt, doc.name, slice.title))
  if (!CHANGE_NAME.test(change)) throw new HttpError(422, 'invalid_change_name', `"${change}" is not a valid change name (a-z, 0-9, -)`)
  if ((await changeNames(target.wt)).includes(change)) throw new HttpError(409, 'change_exists', `A change named ${change} already exists in this worktree`)
  await service.requireReady()
  const notes = input.notes ?? ''
  const decisions = (await readReview(target.ini.dir)).decisions
  return service.begin(target, { kind: 'author', slice: sliceId, change }, authorPrompt(doc, slice, notes, change, decisions), { sliceId, notes, change })
}

// Resume takes the same exclusive key as Propose and re-checks for a running author on the locked
// document, so a Resume and a Propose never run two authors at once (final review I1).
export function resumeAuthor(service: InitiativeRunService, target: RunTarget, runId: string): Promise<void> {
  const busy = new HttpError(409, 'author_running', 'An author run of this initiative is already starting')
  return service.resumeRun(target, runId, {}, (decisions) => buildResumePrompt(decisions, 'Continue writing the change with these choices.'), {
    key: `${target.ini.dir}#author`, busy, check: authorRunning,
  })
}

export const finishAuthor: Finisher<'author'> = async (ctx, reply) => withInitiativeLock(ctx.target.ini.dir, async () => {
  if (reply.status === 'failed') return ctx.record('failed', reply.answer)
  const { wt, ini } = ctx.target
  if (reply.status === 'needs_owner') {
    await raiseRunDecisions(ctx,ini.dir,reply.decisions)
    return ctx.record('needs_owner',reply.answer)
  }
  const saved = (await readInitiativeStream(ini.dir)).events.some(({event}) => event.type === 'InitiativeRunGitRequested' && event.runId === ctx.run.id && event.attemptId === ctx.attempt.id)
  if (!saved) {
    const out = path.join(ctx.paths.runDir,'receipt-out')
    await mkdir(out,{recursive:true})
    for (const file of ctx.result.outputs) {
      if (!file.path || file.path.includes('\\') || file.path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) return ctx.record('failed','The recorded output contains an unsafe path')
      const target = path.join(out,file.path)
      await mkdir(path.dirname(target),{recursive:true})
      const before = await readFile(target,'utf8').catch(()=>null)
      if (before!==null && before!==file.content) return ctx.record('uncertain','The immutable received output changed')
      if (before===null) await writeFile(target,file.content,{flag:'wx',mode:file.mode})
    }
    const vet=await vetAuthorOutput({out,change:reply.change,worktree:wt.path,openspecBin:ctx.config.openspecBin,token:ctx.token})
    const keys=new Set(vet.scenarioKeys)
    const problems=[...vet.problems,...reply.decisions.flatMap((decision,i)=>decision.scope.kind==='scenario'&&!keys.has(decision.scope.key)?[`decisions[${i}]: unknown scenario ${decision.scope.key}`]:[])]
    if(problems.length)return ctx.record('failed','The output did not pass vetting; nothing was moved.',problems)
  }
  const commit=await runGitEffect(ctx,{purpose:{kind:'author-result',ref:ctx.run.id},outputs:ctx.result.outputs.map(file=>({path:file.path,content:Buffer.from(file.content),mode:file.mode})),extraFiles:[`${ini.relDir}/initiative.events.jsonl`],message:initiativeCommitMessage(`${reply.change} - slice ${ctx.run.slice} executable contract`,ctx.config.commitTrailer)})
  if(!commit)return
  const dir=path.join(wt.path,'openspec/changes',reply.change)
  await raiseRunDecisions(ctx,dir,reply.decisions)
  await executeInitiativeCommand(ini.dir,{type:'associate-change',slice:ctx.run.slice??'',change:reply.change},ctx.at)
  await ctx.record('done',reply.answer)
})
