import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { addDecisions, dismissDecision, ownerDecision } from '../decision-model.ts'
import { decideInitiativeDecision } from '../initiative-decisions.ts'
import { OptionSchema } from '../protocol.ts'
import { nowIso, updateReview } from '../review-store.ts'
import type { RunTarget } from '../run-service.ts'
import { publishInitiativeChanged, resolveInitiativeTarget } from './resolve.ts'

// Sub-project A's decision routes, addressed to an initiative (spec B §9): every initiative
// decision is about the whole initiative (`scope: {kind: change}`).
const NewDecision = z
  .object({
    question: z.string().trim().min(1).max(400),
    blocking: z.boolean(),
    options: z.array(OptionSchema).max(4).default([]),
  })
  .refine((b) => b.options.length !== 1, { message: 'give no options or 2 to 4', path: ['options'] })
  .refine((b) => new Set(b.options.map((o) => o.id)).size === b.options.length, { message: 'option ids must be unique', path: ['options'] })
const Decide = z.object({ option: z.string().min(1).nullable().optional(), note: z.string().max(2000).optional() })
const Dismiss = z.object({ reason: z.string().trim().min(1).max(400) })

export function registerInitiativeDecisionRoutes(app: Hono, ctx: AppContext): void {
  const base = '/api/initiatives/:wt/:name/decisions'
  const target = (c: Context): Promise<RunTarget> => resolveInitiativeTarget(ctx, c)
  const changed = (t: RunTarget) => publishInitiativeChanged(ctx, t)

  app.post(base, async (c) => {
    const t = await target(c)
    const body = NewDecision.parse(await c.req.json())
    const record = ownerDecision({ ...body, scope: { kind: 'change' } }, nowIso())
    await updateReview(t.ini.dir, (doc) => addDecisions(doc, [record]))
    changed(t)
    return c.json({ id: record.id }, 201)
  })

  app.post(`${base}/:id/decide`, async (c) => {
    const t = await target(c)
    const body = Decide.parse(await c.req.json())
    const { commit } = await decideInitiativeDecision(t, c.req.param('id'), { option: body.option ?? null, note: body.note ?? '' }, ctx.config.commitTrailer)
    changed(t)
    return c.json({ status: 'recorded', commit })
  })

  app.post(`${base}/:id/dismiss`, async (c) => {
    const t = await target(c)
    const { reason } = Dismiss.parse(await c.req.json())
    await updateReview(t.ini.dir, (doc) => dismissDecision(doc, c.req.param('id'), reason, nowIso()))
    changed(t)
    return c.json({ ok: true })
  })
}
