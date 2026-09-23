import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import { loadChangeView } from '../change-view.ts'
import { corpusReport } from '../corpus.ts'
import { resolveChange } from './resolve.ts'

export function registerCorpusRoutes(app: Hono, ctx: AppContext): void {
  app.get('/api/changes/:wt/:name/corpus', async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    return c.json(await corpusReport(wt, await loadChangeView(wt, ref, { withCommits: false })))
  })
}
