import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { addDecisions, decisionsFromReply } from './decision-model.ts'
import type { WorktreeInfo } from './discovery.ts'
import { HttpError } from './errors.ts'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import { authorPrompt } from './initiative-prompt.ts'
import { CHANGE_NAME, findSlice, INITIATIVE_FILE, type InitiativeDoc, readInitiative, type RunRecord } from './initiative-store.ts'
import { sliceStatuses } from './initiatives.ts'
import { buildResumePrompt } from './prompt.ts'
import { emptyReview, readReview, updateReview, writeReview } from './review-store.ts'
import type { Finisher, InitiativeRunService, RunTarget } from './run-service.ts'
import { proposeBlocker } from './slice-plan.ts'
import { moveChange, vetAuthorOutput } from './vet-output.ts'

// Spec B §4.4: a clean-room author writes one slice as a behavior-driven change.
export { CHANGE_NAME } from './initiative-store.ts'

export const slugify = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

async function changeNames(wt: WorktreeInfo): Promise<string[]> {
  const root = path.join(wt.path, 'openspec', 'changes')
  const active = await readdir(root).catch(() => [] as string[])
  const archived = await readdir(path.join(root, 'archive')).catch(() => [] as string[])
  return [...active, ...archived.map((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, ''))]
}

// add-<initiative>-<slice title slug>, unique in the worktree (-2, -3, … on a clash).
export async function defaultChangeName(wt: WorktreeInfo, initiative: string, title: string): Promise<string> {
  const taken = new Set(await changeNames(wt))
  const base = `add-${initiative}-${slugify(title) || 'slice'}`.slice(0, 60).replace(/-+$/, '')
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function authorRunning(doc: InitiativeDoc): void {
  if (doc.runs.some((r) => r.kind === 'author' && r.outcome === 'running')) {
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

export async function resumeAuthor(service: InitiativeRunService, target: RunTarget, runId: string): Promise<void> {
  authorRunning(await readInitiative(target.ini.dir))
  await service.resumeRun(target, runId, {}, (decisions) => buildResumePrompt(decisions, 'Continue writing the change with these choices.'))
}

const setChange = (sliceId: string, change: string | null) => (doc: InitiativeDoc): InitiativeDoc => ({
  ...doc,
  plan: { ...doc.plan, slices: doc.plan.slices.map((s) => (s.id === sliceId ? { ...s, change } : s)) },
})

export const finishAuthor: Finisher<'author'> = async (ctx, reply) => {
  if (reply.status === 'failed') return ctx.record('failed', reply.answer)
  const { wt, ini } = ctx.target
  const source = { kind: 'run' as const, run: ctx.run.id, agent: 'author' as const }
  if (reply.status === 'needs_owner') {
    // Ruling 4: needs_owner decisions go to the initiative inbox.
    await updateReview(ini.dir, (d) => addDecisions(d, decisionsFromReply(reply.decisions, source, ctx.at)))
    return ctx.record('needs_owner', reply.answer)
  }
  const change = reply.change
  const vet = await vetAuthorOutput({ out: ctx.paths.out, change, worktree: wt.path, openspecBin: ctx.config.openspecBin, token: ctx.token })
  const keys = new Set(vet.scenarioKeys)
  const keyProblems = reply.decisions.flatMap((d, i) =>
    d.scope.kind === 'scenario' && !keys.has(d.scope.key) ? [`decisions[${i}].scope.key: no scenario "${d.scope.key}" in ${change}`] : [])
  const problems = [...vet.problems, ...keyProblems]
  if (problems.length) return ctx.record('failed', 'The output did not pass vetting; nothing was moved.', problems)
  const sliceId = ctx.run.slice ?? ''
  const dir = await moveChange(ctx.paths.out, change, wt.path)
  // Ruling 4: a finished author's decisions belong to the new change's own review.yaml.
  await writeReview(dir, addDecisions(emptyReview(), decisionsFromReply(reply.decisions, source, ctx.at)))
  await ctx.record('done', reply.answer, undefined, setChange(sliceId, change))
  const changeRel = `openspec/changes/${change}`
  try {
    await commitPaths(wt.path, [changeRel, `${ini.relDir}/${INITIATIVE_FILE}`], initiativeCommitMessage(`${change} — slice ${sliceId} executable Gherkin (clean room)`, ctx.config.commitTrailer))
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    await ctx.record('failed', `The change was vetted but its commit failed: ${(error as Error).message}`, undefined, setChange(sliceId, null))
  }
}
