import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { type ApplyService } from '../apply.ts'
import { loadChangeView } from '../change-view.ts'
import { corpusReport } from '../corpus.ts'
import { HttpError } from '../errors.ts'
import { assertWritable, resolveChange } from './resolve.ts'
import { sseFromBus } from './sse.ts'

const Resume = z.object({ runId: z.string().min(1) })

export function registerApplyRoutes(app: Hono, ctx: AppContext, deps: { apply: ApplyService }): void {
  const base = '/api/changes/:wt/:name'

  app.post(`${base}/apply`, async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    assertWritable(ref)
    return c.json({ run: await deps.apply.start(wt, ref) }, 202)
  })

  app.post(`${base}/apply/stop`, async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    await deps.apply.stop(wt, ref)
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/apply/resume`, async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    assertWritable(ref)
    const { runId } = Resume.parse(await c.req.json())
    await deps.apply.resumeWithDecisions(wt, ref, runId)
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/reapply`, async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    assertWritable(ref)
    const report = await corpusReport(wt, await loadChangeView(wt, ref, { withCommits: false }))
    if (report.drift.length === 0) throw new HttpError(409, 'no_drift', 'The corpus matches every approved scenario')
    return c.json({ run: await deps.apply.start(wt, ref, { onlyKeys: report.drift }) }, 202)
  })

  app.get(`${base}/runs/:id/events`, (c) => sseFromBus(c, ctx.bus, `run:${c.req.param('id')}`))

  app.get(`${base}/runs/:id/log`, async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    return c.json(await deps.apply.log(wt, ref, c.req.param('id')))
  })
}
