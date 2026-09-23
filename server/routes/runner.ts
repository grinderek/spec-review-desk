import type { Hono } from 'hono'
import type { AppContext } from '../app.ts'
import { HttpError } from '../errors.ts'
import type { RunnerService } from '../runner.ts'
import { resolveWorktree } from './resolve.ts'

export function registerRunnerRoutes(app: Hono, ctx: AppContext, runner: RunnerService): void {
  const worktreePath = async (id: string): Promise<string> => (await resolveWorktree(ctx, id)).path
  const withProfile = async (id: string): Promise<string> => {
    const p = await worktreePath(id)
    if (!runner.profileFor(p)) throw new HttpError(404, 'no_runner', 'No runner profile for this worktree — add one to config.yaml')
    return p
  }

  app.get('/api/runner/:wt', async (c) => c.json({ state: runner.state(await worktreePath(c.req.param('wt'))) }))

  app.post('/api/runner/:wt/start', async (c) => {
    const p = await withProfile(c.req.param('wt'))
    await runner.start(p)
    void runner.runNow(p).catch((error: unknown) => console.error(error))
    return c.json({ state: runner.state(p) })
  })

  app.post('/api/runner/:wt/run', async (c) => {
    const p = await withProfile(c.req.param('wt'))
    void runner.runNow(p).catch((error: unknown) => console.error(error))
    return c.json({ state: runner.state(p) }, 202)
  })
}
