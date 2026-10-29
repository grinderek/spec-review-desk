import { createHash } from 'node:crypto'
import { executeOwnerDecision } from './decision-commands.ts'
import { decisionsFromReply } from './decision-model.ts'
import { executeGitEffect, prepareGitEffect, reconcileGitEffect, type GitEffectInput, type GitEffectPlan } from './git-effect.ts'
import { readInitiativeStream, recordInitiativeEvents } from './initiative-events.ts'
import { readReview } from './review-store.ts'
import type { RunContext } from './run-service.ts'
import { assertWorktreeAdmission } from './execution-admission.ts'

export async function raiseRunDecisions(ctx: RunContext, dir: string, raw: Parameters<typeof decisionsFromReply>[0], requestedDomains?: string[]): Promise<void> {
  const decisions = decisionsFromReply(raw, { kind: 'run', run: ctx.run.id, agent: ctx.run.kind }, ctx.at).map((decision, i) => ({ ...decision,
    id: `d_${createHash('sha256').update(`${ctx.run.id}:${ctx.attempt.id}:${i}`).digest('hex').slice(0,16)}`,
    ...(requestedDomains ? { requested_domains: requestedDomains } : {}),
  }))
  const current = await readReview(dir)
  const missing = decisions.filter(decision => !current.decisions.some(existing => existing.id === decision.id))
  if (missing.length) await executeOwnerDecision(dir, { type: 'RaiseOwnerDecisions', decisions: missing })
}

export async function runGitEffect(ctx: RunContext, input: GitEffectInput): Promise<string | null> {
  const dir = ctx.target.ini.dir
  let stream = await readInitiativeStream(dir)
  let saved = stream.events.findLast(({ event }) => event.type === 'InitiativeRunGitRequested' && event.runId === ctx.run.id && event.attemptId === ctx.attempt.id)?.event
  let fresh = false
  if (!saved || saved.type !== 'InitiativeRunGitRequested') {
    const plan = await prepareGitEffect(ctx.target.wt.path, input)
    if (plan.expectedHead !== ctx.attempt.head) {
      await ctx.record('needs_owner', 'HEAD changed after this attempt started. Resume with current inputs before accepting its result.')
      return null
    }
    await recordInitiativeEvents(dir, stream, [{ type:'InitiativeRunGitRequested',runId:ctx.run.id,attemptId:ctx.attempt.id,plan }], ctx.at)
    saved = { type:'InitiativeRunGitRequested',runId:ctx.run.id,attemptId:ctx.attempt.id,plan }; fresh = true
  }
  const plan: GitEffectPlan = saved.plan
  await assertWorktreeAdmission(ctx.target.wt.path,{operation:'git',runId:ctx.run.execution_id,effectId:plan.effectId})
  const done = (await readInitiativeStream(dir)).events.find(({event}) => event.type === 'InitiativeRunGitCompleted' && event.effectId === plan.effectId)?.event
  if (done?.type === 'InitiativeRunGitCompleted') return done.commit
  const receipt = fresh && !ctx.recovering || ctx.ownerRetry
    ? await executeGitEffect(ctx.target.wt.path, plan, { resumePending:ctx.ownerRetry })
    : await reconcileGitEffect(ctx.target.wt.path, plan)
  if (receipt.status !== 'completed') {
    await ctx.record('uncertain', `Git ${receipt.status}: ${receipt.reason}. Resume explicitly to finish this recorded effect.`)
    return null
  }
  stream = await readInitiativeStream(dir)
  await recordInitiativeEvents(dir, stream, [{type:'InitiativeRunGitCompleted',runId:ctx.run.id,effectId:plan.effectId,commit:receipt.commit}],ctx.at)
  return receipt.commit
}
