import { executeOwnerDecision } from './decision-commands.ts'
import { decisionsFromReply } from './decision-model.ts'
import { HttpError } from './errors.ts'
import { commitPaths, initiativeCommitMessage } from './initiative-git.ts'
import { plannerPrompt } from './initiative-prompt.ts'
import { readInitiative, withInitiativeLock, type RunRecord } from './initiative-store.ts'
import { executeInitiativeCommand } from './initiative-commands.ts'
import { initiativeBusinessPaths } from './inputs.ts'
import { readReview, REVIEW_FILE } from './review-store.ts'
import type { Finisher, InitiativeRunService, RunTarget } from './run-service.ts'
import { slicesFromPlanner } from './slice-plan.ts'

// Spec B §4.2: the planner proposes a slice plan; the result is a committed draft.
export function startPlanner(service: InitiativeRunService, target: RunTarget): Promise<RunRecord> {
  const busy = new HttpError(409, 'planner_running', 'The planner is already starting')
  return service.exclusive(`${target.ini.dir}#planner`, busy, () => withInitiativeLock(target.ini.dir, () => launchPlanner(service, target)))
}

async function launchPlanner(service: InitiativeRunService, target: RunTarget): Promise<RunRecord> {
  const doc = await readInitiative(target.ini.dir)
  if (doc.plan.status === 'approved') throw new HttpError(409, 'plan_approved', 'The slice plan is approved; add or edit slices instead of re-planning')
  if (doc.runs.some((r) => r.kind === 'planner' && r.outcome === 'running')) throw new HttpError(409, 'planner_running', 'The planner is already running')
  await service.requireReady()
  const review = await readReview(target.ini.dir)
  return service.begin(target, { kind: 'planner' }, plannerPrompt(doc, review.decisions))
}

export const finishPlanner: Finisher<'planner'> = async (ctx, reply) => withInitiativeLock(ctx.target.ini.dir, async () => {
  if (reply.status === 'failed') return ctx.record('failed', reply.answer)
  const { wt, ini } = ctx.target
  const decisions = decisionsFromReply(reply.decisions, { kind: 'run', run: ctx.run.id, agent: 'planner' }, ctx.at)
  if (decisions.length) await executeOwnerDecision(ini.dir, { type: 'RaiseOwnerDecisions', decisions })
  await executeInitiativeCommand(ini.dir, { type: 'draft-plan', slices: slicesFromPlanner(reply.slices), run: ctx.run.id }, ctx.at)
  await ctx.record('done', reply.answer)
  const files = [...initiativeBusinessPaths(ini.relDir), ...(decisions.length ? [`${ini.relDir}/${REVIEW_FILE}`] : [])]
  try {
    await commitPaths(wt.path, files, initiativeCommitMessage(`${ini.name} — slice plan draft`, ctx.config.commitTrailer))
  } catch (error) {
    await ctx.record('failed', `The draft was written but its commit failed: ${(error as Error).message}`)
  }
})
