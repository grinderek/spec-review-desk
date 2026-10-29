import { routerStatus } from '../router-runtime.ts'
import { readUsage } from '../agent-usage.ts'
import { readProducts } from '../products.ts'
import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import { findScenario, loadChangeView, summarize } from '../change-view.ts'
import { parseNativeContract } from '../change-package.ts'
import { loadCorpus } from '../corpus.ts'
import { discover } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { showFile } from '../git.ts'
import { initiativeTags } from '../initiatives.ts'
import { resolveChange, resolveWorktree } from './resolve.ts'
import { sseFromBus } from './sse.ts'

export interface Capabilities { codex: boolean; docker: boolean }

export function registerReadRoutes(app: Hono, ctx: AppContext, capabilities: Capabilities): void {
  app.get('/api/usage', async c => c.json({ ...await readUsage(ctx.config), router: await routerStatus(ctx.config) }))
  app.get('/api/status', (c) => c.json({ capabilities }))
  app.get('/api/products', async c => c.json(await readProducts(ctx.config)))

  app.get('/api/rules/:wt', async c => {
    const wt = await resolveWorktree(ctx, c.req.param('wt'))
    return c.json(await loadCorpus(wt.path))
  })

  app.get('/api/changes', async (c) => {
    const trees = await discover(ctx.config.repos, ctx.registry)
    const repos = await Promise.all(
      trees.map(async (tree) => ({
        repo: tree.repo,
        worktrees: await Promise.all(
          tree.worktrees.map(async (w) => {
            // Spec B §8: a change that belongs to an initiative carries "initiative · sN".
            const tags = await initiativeTags(w)
            return {
              id: w.id,
              path: w.path,
              branch: w.branch,
              head: w.head,
              changes: await Promise.all(w.changes.map(async (ref) => ({
                ...summarize(await loadChangeView(w, ref, { withCommits: false })),
                initiative: tags[ref.name] ?? null,
              }))),
            }
          }),
        ),
      })),
    )
    return c.json({ repos })
  })

  app.get('/api/changes/:wt/:name', async (c) => {
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    return c.json(await loadChangeView(wt, ref))
  })

  app.get('/api/changes/:wt/:name/scenario-diff', async (c) => {
    const key = c.req.query('key')
    if (!key) throw new HttpError(400, 'missing_key', 'The key query parameter is required')
    const { wt, ref } = await resolveChange(ctx, c.req.param('wt'), c.req.param('name'))
    const view = await loadChangeView(wt, ref, { withCommits: false })
    const scenario = findScenario(view, key)
    if (!scenario) throw new HttpError(404, 'unknown_scenario', `No scenario ${key}`)
    const commit = scenario.effective.approvedCommit
    const previous = commit ? await showFile(wt.path, commit, `${view.relDir}/${scenario.file}`) : null
    let before: string | null = null
    if (previous) {
      try {
        before = parseNativeContract(previous, scenario.file).contracts.find(contract => contract.key === key)?.scenario.source ?? null
      } catch {
        before = null
      }
    }
    return c.json({ before, after: scenario.source, approvedCommit: commit })
  })

  app.get('/api/events', (c) => sseFromBus(c, ctx.bus, '*'))
}
