import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { ApplyService } from './apply.ts'
import { createBaseApp } from './app.ts'
import { loadConfig } from './config.ts'
import { type ChangeRef, discover, listChanges, Registry, type WorktreeInfo } from './discovery.ts'
import { EventBus } from './events.ts'
import { run } from './git.ts'
import { QuestionService } from './questions.ts'
import { registerApplyRoutes } from './routes/apply.ts'
import { registerCorpusRoutes } from './routes/corpus.ts'
import { registerDecisionRoutes } from './routes/decisions.ts'
import { registerReadRoutes } from './routes/read.ts'
import { registerReviewRoutes } from './routes/review.ts'
import { registerRunnerRoutes } from './routes/runner.ts'
import { registerThreadRoutes } from './routes/threads.ts'
import { RunnerService } from './runner.ts'
import { watchChanges } from './watch.ts'

export interface StartOptions { configPath: string; dev?: boolean; token?: string; port?: number }

async function available(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { cwd: process.cwd(), timeoutMs: 15_000 })
    return true
  } catch {
    return false
  }
}

export async function startServer(opts: StartOptions) {
  const loaded = await loadConfig(opts.configPath)
  const config = opts.port ? { ...loaded, port: opts.port } : loaded
  const token = opts.token ?? randomBytes(24).toString('base64url')
  const bus = new EventBus()
  const registry = new Registry()
  await discover(config.repos, registry)
  const capabilities = {
    claude: await available(config.claudeBin, ['--version']),
    docker: await available('docker', ['version', '--format', '{{.Client.Version}}']),
  }
  const ctx = { config, token, bus, registry }
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, capabilities)
  const questions = new QuestionService({ config, bus })
  const apply = new ApplyService({ config, bus })
  const resumeApply = (wt: WorktreeInfo, ref: ChangeRef, id: string) =>
    apply.resume(wt, ref, id).catch((error: unknown) => {
      console.error(error)
      bus.publish(`thread:${id}`, { type: 'done', ok: false })
    })
  const threadDeps = { questions, applyActive: (p: string) => apply.active(p), resumeApply }
  registerThreadRoutes(app, ctx, threadDeps)
  registerReviewRoutes(app, ctx, { questions })
  registerDecisionRoutes(app, ctx, { questions })
  const runner = new RunnerService({ profiles: config.runners, bus })
  await Promise.all(config.runners.map((p) => runner.loadLast(p.worktreePath)))
  if (capabilities.docker) await Promise.all(config.runners.map((p) => runner.refreshUp(p.worktreePath).catch(() => false)))
  const stopRunner = capabilities.docker ? runner.watch() : async () => undefined
  registerRunnerRoutes(app, ctx, runner)
  registerCorpusRoutes(app, ctx)
  registerApplyRoutes(app, ctx, { apply })
  for (const wt of registry.all()) {
    for (const ref of await listChanges(wt)) await apply.reattach(wt, ref).catch((error: unknown) => console.error(error))
  }
  // SERVICES: later tasks create their services and register their routes here.

  if (!opts.dev) {
    const root = path.relative(process.cwd(), fileURLToPath(new URL('../ui/dist', import.meta.url)))
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ path: path.join(root, 'index.html') }))
  }
  const stopWatching = watchChanges(registry.all(), bus)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port })
  const base = opts.dev ? config.devUiOrigin : `http://127.0.0.1:${config.port}`
  console.log(`Spec Review Desk: ${base}/?t=${token}`)
  if (!capabilities.claude) console.warn(`${config.claudeBin} not found on PATH — threads and Apply are disabled`)
  if (!capabilities.docker) console.warn('docker not found — the corpus runner is disabled')
  return {
    app,
    config,
    close: async () => {
      await stopWatching()
      await stopRunner()
      server.close()
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--config')
  const configPath = index >= 0 && args[index + 1] ? args[index + 1]! : 'config.yaml'
  startServer({ configPath, dev: args.includes('--dev'), token: process.env.SPEC_REVIEW_TOKEN }).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
