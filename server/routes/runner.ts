import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import { HttpError } from '../errors.ts'
import type { RunnerService } from '../runner.ts'
import { resolveWorktree } from './resolve.ts'

export type RunnerRouteService = Pick<RunnerService, 'profileFor' | 'state' | 'refresh' | 'start' | 'runNow' | 'stop'>
export function registerRunnerRoutes(app: Hono, ctx: AppContext, runner: RunnerRouteService): void {
  const worktreePath = async (id: string): Promise<string> => (await resolveWorktree(ctx, id)).path
  const withProfile = async (id: string): Promise<string> => {
    const p = await worktreePath(id)
    if (!runner.profileFor(p)) throw new HttpError(404, 'no_runner', 'No runner profile for this worktree - add one to the workspace configuration')
    return p
  }

  app.get('/api/runner/:wt', async (c) => {
    const p = await worktreePath(c.req.param('wt'))
    if (runner.profileFor(p)) await runner.refresh(p)
    return c.json({ state: runner.state(p) })
  })

  app.post('/api/runner/:wt/start', async (c) => {
    const p = await withProfile(c.req.param('wt'))
    await runner.start(p)
    await runner.runNow(p)
    return c.json({ state: runner.state(p) })
  })

  app.post('/api/runner/:wt/run', async (c) => {
    const p = await withProfile(c.req.param('wt'))
    await runner.runNow(p)
    return c.json({ state: runner.state(p) }, 202)
  })

  app.post('/api/runner/:wt/stop', async (c) => {
    const p = await withProfile(c.req.param('wt'))
    await runner.stop(p)
    return c.json({ state: runner.state(p) }, 202)
  })
}
