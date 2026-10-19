import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { readInitiativeStream } from './initiative-events.ts'
import { renderInitiative } from './initiative-store.ts'
import { raiseRunDecisions, runGitEffect } from './initiative-finalization.ts'
import { executeOwnerDecision } from './decision-commands.ts'
import { decisionsFromReply } from './decision-model.ts'
import { HttpError } from './errors.ts'
import { initiativeCommitMessage } from './initiative-git.ts'
import { plannerPrompt } from './initiative-prompt.ts'
import { readInitiative, withInitiativeLock, type RunRecord } from './initiative-store.ts'
import { executeInitiativeCommand } from './initiative-commands.ts'
import { readReview, REVIEW_FILE } from './review-store.ts'
import type { Finisher, InitiativeRunService, RunTarget } from './run-service.ts'
import { slicesFromPlanner } from './slice-plan.ts'

// Spec B §4.2: the planner proposes a slice plan; the result is a committed draft.
export function startPlanner(service: InitiativeRunService, target: RunTarget): Promise<RunRecord> {
  const busy = new HttpError(409, 'planner_running', 'The planner is already starting')
  return service.exclusive(`${target.ini.dir}#planner`, busy, () => launchPlanner(service, target))
}

async function launchPlanner(service: InitiativeRunService, target: RunTarget): Promise<RunRecord> {
  const doc = await readInitiative(target.ini.dir)
  if (doc.plan.status === 'approved') throw new HttpError(409, 'plan_approved', 'The slice plan is approved; add or edit slices instead of re-planning')
  if (doc.runs.some((r) => r.kind === 'planner' && ['running','queued','uncertain','needs_owner'].includes(r.outcome))) throw new HttpError(409, 'planner_running', 'The planner has unresolved execution state')
  await service.requireReady()
  const review = await readReview(target.ini.dir)
  return service.begin(target, { kind: 'planner' }, plannerPrompt(doc, review.decisions))
}

export const finishPlanner: Finisher<'planner'> = async (ctx, reply) => withInitiativeLock(ctx.target.ini.dir, async () => {
  if (reply.status === 'failed') return ctx.record('failed', reply.answer)
  const { wt, ini } = ctx.target
  const stream = await readInitiativeStream(ini.dir)
  const drafted = stream.events.some(({event}) => event.type === 'SlicePlanDrafted' && event.run === ctx.run.id && event.attempt === ctx.attempt.id)
  const doc = await readInitiative(ini.dir)
  const expected = slicesFromPlanner(reply.slices)
  if (!drafted && createHash('sha256').update(JSON.stringify(doc.plan)).digest('hex') !== ctx.input.source.planHash) return ctx.record('needs_owner','The plan changed after this attempt started. Resume with the revised plan.')
  await raiseRunDecisions(ctx,ini.dir,reply.decisions)
  if (!drafted) await executeInitiativeCommand(ini.dir,{type:'draft-plan',slices:expected,run:ctx.run.id,attempt:ctx.attempt.id},ctx.at)
  const current = await readInitiative(ini.dir)
  if (JSON.stringify(current.plan.slices) !== JSON.stringify(expected) || current.plan.status !== 'draft') return ctx.record('needs_owner','The owner edited the drafted plan. Its later edits will not be overwritten.')
  const reviewJournal = await readFile(path.join(ini.dir,'review.events.jsonl')).then(()=>true,()=>false)
  const commit = await runGitEffect(ctx,{purpose:{kind:'planner-result',ref:ctx.run.id},outputs:[{path:`${ini.relDir}/plans/${ctx.attempt.id}.yaml`,content:Buffer.from(stringify({run:ctx.run.id,attempt:ctx.attempt.id,plan:current.plan}))}],extraFiles:[`${ini.relDir}/initiative.yaml`,`${ini.relDir}/initiative.events.jsonl`,...(reviewJournal?[`${ini.relDir}/review.events.jsonl`]:[])],message:initiativeCommitMessage(`${ini.name} - slice plan draft`,ctx.config.commitTrailer)})
  if (commit) await ctx.record('done',reply.answer)
})
