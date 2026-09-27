import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { findScenario, loadChangeView } from '../change-view.ts'
import {
  addDecisions, decideDecision, type DecisionChoiceInput, dismissDecision, findDecision, ownerDecision, ownerDecisionText, reattachDecision,
} from '../decision-model.ts'
import { commitChangeDecision } from '../decisions-md.ts'
import type { ChangeRef, WorktreeInfo } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { OptionSchema, ScopeSchema } from '../protocol.ts'
import { ownerMessage, type QuestionService } from '../questions.ts'
import { addThread, appendMessage, newId, nowIso, readReview, type ReviewDoc, setThreadStatus, updateReview } from '../review-store.ts'
import { assertWritable, relDirOf, resolveChange } from './resolve.ts'

const NewDecision = z
  .object({
    question: z.string().trim().min(1).max(400),
    scope: ScopeSchema,
    blocking: z.boolean(),
    options: z.array(OptionSchema).max(4).default([]),
  })
  .refine((b) => b.options.length !== 1, { message: 'give no options or 2 to 4', path: ['options'] })
  .refine((b) => new Set(b.options.map((o) => o.id)).size === b.options.length, { message: 'option ids must be unique', path: ['options'] })
const Decide = z.object({ option: z.string().min(1).nullable().optional(), note: z.string().max(2000).optional() })
const Dismiss = z.object({ reason: z.string().trim().min(1).max(400) })
const Reattach = z.object({ to: z.string().min(1) })

export interface DecisionRouteDeps { questions: QuestionService }

// Spec §6: a decided scenario decision goes back to the agent — into the thread that raised it, or
// a new thread on its scenario — asking for the "# Owner decision" patch that resolves it.
function postDecision(doc: ReviewDoc, decisionId: string, newThreadId: string, at: string): { doc: ReviewDoc; threadId: string } {
  const decided = findDecision(doc, decisionId)
  if (decided.scope.kind !== 'scenario') return { doc, threadId: newThreadId }
  const message = ownerMessage(ownerDecisionText(decided, at.slice(0, 10)), new Date(at))
  const source = decided.source
  const existing = source.kind === 'thread' ? doc.threads.find((t) => t.id === source.id && t.anchor !== 'apply') : undefined
  if (existing) return { doc: setThreadStatus(appendMessage(doc, existing.id, message), existing.id, 'open'), threadId: existing.id }
  return {
    doc: addThread(doc, { id: newThreadId, anchor: 'scenario', ref: decided.scope.key, status: 'open', messages: [message] }),
    threadId: newThreadId,
  }
}

export function registerDecisionRoutes(app: Hono, ctx: AppContext, deps: DecisionRouteDeps): void {
  const base = '/api/changes/:wt/:name/decisions'
  const target = async (wtId: string, name: string) => {
    const resolved = await resolveChange(ctx, wtId, name)
    assertWritable(resolved.ref)
    return resolved
  }
  const changed = (wt: WorktreeInfo, ref: ChangeRef) => ctx.bus.publish('change', { worktreeId: wt.id, name: ref.name })
  const requireScenario = async (wt: WorktreeInfo, ref: ChangeRef, key: string): Promise<void> => {
    const view = await loadChangeView(wt, ref, { withCommits: false })
    if (!findScenario(view, key)) throw new HttpError(404, 'unknown_scenario', `No scenario ${key}`)
  }

  app.post(base, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const body = NewDecision.parse(await c.req.json())
    if (body.scope.kind === 'scenario') await requireScenario(wt, ref, body.scope.key)
    const record = ownerDecision(body, nowIso())
    await updateReview(ref.dir, (doc) => addDecisions(doc, [record]))
    changed(wt, ref)
    return c.json({ id: record.id }, 201)
  })

  app.post(`${base}/:id/decide`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const body = Decide.parse(await c.req.json())
    const choice: DecisionChoiceInput = { option: body.option ?? null, note: body.note ?? '' }
    const decision = findDecision(await readReview(ref.dir), id)
    if (decision.scope.kind === 'change') {
      const { commit } = await commitChangeDecision({
        cwd: wt.path,
        relDir: relDirOf(wt, ref),
        changeDir: ref.dir,
        changeName: ref.name,
        decisionId: id,
        choice,
        trailer: ctx.config.commitTrailer,
        now: new Date(),
      })
      changed(wt, ref)
      return c.json({ status: 'recorded', commit })
    }
    const view = await loadChangeView(wt, ref, { withCommits: false })
    if (!findScenario(view, decision.scope.key)) {
      throw new HttpError(409, 'decision_orphaned', `The scenario ${decision.scope.key} no longer exists — re-attach or dismiss the decision`)
    }
    const at = nowIso()
    const fresh = newId('t')
    let threadId = fresh
    await updateReview(ref.dir, (doc) => {
      const posted = postDecision(decideDecision(doc, id, choice, at), id, fresh, at)
      threadId = posted.threadId
      return posted.doc
    })
    void deps.questions.ask(wt, ref, threadId)
    changed(wt, ref)
    return c.json({ status: 'decided', threadId })
  })

  app.post(`${base}/:id/dismiss`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const { reason } = Dismiss.parse(await c.req.json())
    await updateReview(ref.dir, (doc) => dismissDecision(doc, c.req.param('id'), reason, nowIso()))
    changed(wt, ref)
    return c.json({ ok: true })
  })

  app.post(`${base}/:id/reattach`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const { to } = Reattach.parse(await c.req.json())
    await requireScenario(wt, ref, to)
    await updateReview(ref.dir, (doc) => reattachDecision(doc, c.req.param('id'), to))
    changed(wt, ref)
    return c.json({ ok: true })
  })
}
