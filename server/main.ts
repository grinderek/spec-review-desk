import { reconcileInitiativeOwnerEffects } from './initiative-owner-effects.ts'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { startRouter } from './router-runtime.ts'
import { ApplyService } from './apply.ts'
import { recoverChangeApproval } from './approval-effects.ts'
import { recoverInitiativeCreations } from './initiative-create.ts'
import { createBaseApp } from './app.ts'
import { configPathFromArgs, loadConfig } from './config.ts'
import { type ChangeRef, discover, listChanges, listWorktrees, Registry, type WorktreeInfo } from './discovery.ts'
import { EventBus } from './events.ts'
import { run } from './git.ts'
import { listInitiatives } from './initiatives.ts'
import { QuestionService } from './questions.ts'
import { registerApplyRoutes } from './routes/apply.ts'
import { registerCorpusRoutes } from './routes/corpus.ts'
import { registerDecisionRoutes } from './routes/decisions.ts'
import { registerInitiativeDecisionRoutes } from './routes/initiative-decisions.ts'
import { registerInitiativeRoutes } from './routes/initiatives.ts'
import { registerReadRoutes } from './routes/read.ts'
import { registerReviewRoutes } from './routes/review.ts'
import { registerRunnerRoutes } from './routes/runner.ts'
import { registerThreadRoutes } from './routes/threads.ts'
import { FINISHERS } from './run-kinds.ts'
import { InitiativeRunService } from './run-service.ts'
import { RunnerService } from './runner.ts'
import { DockerSandbox, type Sandbox } from './sandbox.ts'
import { watchChanges } from './watch.ts'

export interface StartOptions { configPath: string; dev?: boolean; token?: string; port?: number; sandbox?: Sandbox; autoRun?: boolean }

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
  const stopRouter = await startRouter(config)
  const bus = new EventBus()
  const registry = new Registry()
  await discover(config.repos, registry)
  const capabilities = {
    codex: await available(config.codexBin, ['--version']),
    docker: await available('docker', ['version', '--format', '{{.Client.Version}}']),
  }
  const ctx = { config, token, bus, registry }
  const app = createBaseApp(ctx)
  registerReadRoutes(app, ctx, capabilities)
  const questions = new QuestionService({ config, bus })
  const apply = new ApplyService({ config, bus })
  const resumeApply = (wt: WorktreeInfo, ref: ChangeRef, id: string, text?: string) => apply.resume(wt, ref, id, text)
  const threadDeps = { questions, applyActive: (p: string) => apply.active(p), resumeApply }
  registerThreadRoutes(app, ctx, threadDeps)
  registerReviewRoutes(app, ctx, { questions })
  registerDecisionRoutes(app, ctx, { questions })
  const runner = new RunnerService({ profiles: config.runners, bus })
  await Promise.all(config.runners.map((p) => runner.loadLast(p.worktreePath)))
  await Promise.all(config.runners.filter((p) => capabilities.docker || p.execution === 'local').map((p) => runner.refreshUp(p.worktreePath).catch(() => false)))
  const stopRunner = opts.autoRun !== false && (capabilities.docker || config.runners.some((p) => p.execution === 'local')) ? runner.watch() : async () => undefined
  registerRunnerRoutes(app, ctx, runner)
  registerCorpusRoutes(app, ctx)
  registerApplyRoutes(app, ctx, { apply })
  for (const wt of registry.all()) {
    for (const ref of await listChanges(wt)) {
      await recoverChangeApproval(wt, ref).catch((error: unknown) => console.error(error))
      await apply.reattach(wt, ref).catch((error: unknown) => console.error(error))
      await questions.recover(wt, ref).catch((error: unknown) => console.error(error))
    }
  }
  // Spec B: initiatives and their sandboxed research/planner/author runs.
  const sandbox = opts.sandbox ?? new DockerSandbox(config.sandbox)
  const runs = new InitiativeRunService({ config, bus, sandbox, finishers: FINISHERS })
  registerInitiativeRoutes(app, ctx, { runs, sandbox })
  registerInitiativeDecisionRoutes(app, ctx)
  for (const repo of config.repos) {
    await recoverInitiativeCreations(config, repo.name).catch((error: unknown) => console.error(error))
    for (const wt of await listWorktrees(repo)) {
      for (const ini of await listInitiatives(wt)) {
        await reconcileInitiativeOwnerEffects({wt,ini}).catch((error:unknown)=>console.error(error))
        await runs.failStale({wt,ini}).catch((error:unknown)=>console.error(error))
      }
    }
  }
  // SERVICES: later tasks create their services and register their routes here.

  if (!opts.dev) {
    const root = path.relative(process.cwd(), fileURLToPath(new URL('../ui/dist', import.meta.url)))
    app.use('/*', serveStatic({ root }))
    app.get('*', serveStatic({ path: path.join(root, 'index.html') }))
  }
  const stopWatching = watchChanges(registry.all(), bus)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port })
  await new Promise<void>((resolve, reject) => {
    const listening = () => { server.off('error', failed); resolve() }
    const failed = (error: Error) => { server.off('listening', listening); reject(error) }
    server.once('listening', listening)
    server.once('error', failed)
  })
  const base = opts.dev ? config.devUiOrigin : `http://127.0.0.1:${config.port}`
  console.log(`Spec Review Desk: ${base}/?t=${token}`)
  if (opts.autoRun === false) console.log('Automatic corpus runs are disabled for this session')
  if (!capabilities.codex) console.warn(`${config.codexBin} not found on PATH - threads and Apply are disabled`)
  if (!capabilities.docker) console.warn('docker not found - Compose runners and initiative agents are unavailable; local runners remain available')
  return {
    app,
    config,
    close: async () => {
      stopRouter()
      await stopWatching()
      await stopRunner()
      server.close()
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  Promise.resolve().then(() => startServer({ configPath: configPathFromArgs(args), dev: args.includes('--dev'), autoRun: !args.includes('--no-auto-run'), token: process.env.SPEC_REVIEW_TOKEN })).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
