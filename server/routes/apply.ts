import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import { type ApplyService, readEvents } from '../apply.ts'
import { loadChangeView } from '../change-view.ts'
import { corpusReport } from '../corpus.ts'
import { HttpError } from '../errors.ts'
import { readReview } from '../review-store.ts'
import { assertWritable, resolveChange } from './resolve.ts'
import { sseFromBus } from './sse.ts'

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
    const run = (await readReview(ref.dir)).apply_runs.find((r) => r.id === c.req.param('id'))
    if (!run) throw new HttpError(404, 'unknown_run', `No apply run ${c.req.param('id')}`)
    const events = readEvents(await readFile(path.join(wt.path, run.log), 'utf8').catch(() => ''))
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
    return c.json({ run, text })
  })
}
