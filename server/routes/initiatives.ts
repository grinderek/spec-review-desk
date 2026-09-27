import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { resumeAuthor, startAuthor } from '../author-run.ts'
import { pendingBlocking } from '../decision-model.ts'
import { listWorktrees } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { commitPaths, initiativeCommitMessage } from '../initiative-git.ts'
import { type CreateInput, createInitiative } from '../initiative-create.ts'
import { findRun, INITIATIVE_FILE, readInitiative, updateInitiative } from '../initiative-store.ts'
import { findInitiative, listInitiatives, loadInitiativeView, sliceStatuses, summarizeInitiative } from '../initiatives.ts'
import { acceptDraft, discardDraft, type IncomingFile, readRepoFile, setDomains, uploadInputs } from '../inputs.ts'
import { startPlanner } from '../planner-run.ts'
import { resumeResearch, startResearch } from '../research-run.ts'
import { nowIso, readReview } from '../review-store.ts'
import type { InitiativeRunService, RunTarget } from '../run-service.ts'
import type { Sandbox } from '../sandbox.ts'
import { approvePlan, editPlan } from '../slice-plan.ts'
import { resolveWorktree } from './resolve.ts'
import { sseFromBus } from './sse.ts'

export interface InitiativeRouteDeps { runs: InitiativeRunService; sandbox: Sandbox }

const Research = z.object({ topic: z.string().trim().min(1).max(120), questions: z.string().trim().min(1).max(4000) })
const Domains = z.object({ domains: z.array(z.string()).max(50) })
const PlanEdit = z.object({
  slices: z.array(z.object({
    id: z.string().nullable(),
    title: z.string().trim().min(1).max(120),
    scope: z.string().trim().min(1).max(2000),
    depends_on: z.array(z.string()).max(12),
  })).max(30),
})
const Propose = z.object({ notes: z.string().max(4000).optional(), change: z.string().max(64).optional() })
const FromRepo = z.object({ from: z.string().min(1) })
const CreateFields = z.object({
  name: z.string().trim(),
  repo: z.string().min(1),
  where: z.enum(['new', 'existing']),
  base: z.string().trim().optional(),
  worktreeId: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  brief: z.string().max(20_000).default(''),
})

type Form = Record<string, string | File | (string | File)[]>
const all = (form: Form, key: string): (string | File)[] => {
  const value = form[key] ?? form[`${key}[]`]
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}
const text = (form: Form, key: string): string | undefined => all(form, key).find((v): v is string => typeof v === 'string')
async function uploads(form: Form): Promise<IncomingFile[]> {
  const files = all(form, 'files').filter((v): v is File => typeof v !== 'string')
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), source: { kind: 'upload' as const } })))
}

export function registerInitiativeRoutes(app: Hono, ctx: AppContext, deps: InitiativeRouteDeps): void {
  const base = '/api/initiatives/:wt/:name'
  const target = async (c: Context): Promise<RunTarget> => {
    const wt = await resolveWorktree(ctx, c.req.param('wt')!)
    return { wt, ini: await findInitiative(wt, c.req.param('name')!) }
  }
  const changed = (t: RunTarget) => ctx.bus.publish('initiative', { worktreeId: t.wt.id, name: t.ini.name })
  const trailer = ctx.config.commitTrailer

  app.get('/api/sandbox/status', async (c) => c.json(await deps.sandbox.status()))

  // The sidebar list, plus what the New feature dialog offers: repos, their worktrees, the base.
  app.get('/api/initiatives', async (c) => {
    const summaries = []
    const repos = []
    for (const repo of ctx.config.repos) {
      const worktrees = await listWorktrees(repo)
      repos.push({ name: repo.name, path: repo.path, worktrees: worktrees.map((w) => ({ id: w.id, path: w.path, branch: w.branch })) })
      for (const wt of worktrees) {
        for (const ref of await listInitiatives(wt)) summaries.push(summarizeInitiative(await loadInitiativeView(wt, ref)))
      }
    }
    return c.json({ initiatives: summaries, repos, defaultBase: ctx.config.initiativeBase })
  })

  app.post('/api/initiatives', async (c) => {
    const form = (await c.req.parseBody({ all: true })) as Form
    const fields = CreateFields.parse({ ...Object.fromEntries(Object.keys(form).map((k) => [k, text(form, k)])) })
    const where: CreateInput['where'] = fields.where === 'new'
      ? { kind: 'new', base: fields.base || ctx.config.initiativeBase }
      : { kind: 'existing', worktreeId: fields.worktreeId ?? '' }
    const fromRepo = all(form, 'fromRepo').flatMap((v) => (typeof v === 'string' ? v.split('\n').map((l) => l.trim()).filter(Boolean) : []))
    const created = await createInitiative(ctx.config, ctx.registry, {
      name: fields.name, repo: fields.repo, where, title: fields.title, brief: fields.brief, files: await uploads(form), fromRepo,
    }, nowIso())
    ctx.bus.publish('initiative', created)
    return c.json(created, 201)
  })

  app.get(base, async (c) => {
    const t = await target(c)
    return c.json(await loadInitiativeView(t.wt, t.ini))
  })

  app.post(`${base}/inputs`, async (c) => {
    const t = await target(c)
    const json = (c.req.header('content-type') ?? '').includes('application/json')
    const files = json
      ? [await readRepoFile([ctx.config.hubRoot, ...ctx.config.repos.map((r) => r.path)], ctx.config.hubRoot, FromRepo.parse(await c.req.json()).from)]
      : await uploads((await c.req.parseBody({ all: true })) as Form)
    const names = await uploadInputs(t, files, trailer, nowIso())
    changed(t)
    return c.json({ files: names }, 201)
  })

  app.post(`${base}/inputs/:file/accept`, async (c) => {
    const t = await target(c)
    const result = await acceptDraft(t, c.req.param('file'), trailer)
    changed(t)
    return c.json(result)
  })

  app.post(`${base}/inputs/:file/discard`, async (c) => {
    const t = await target(c)
    await discardDraft(t, c.req.param('file'))
    changed(t)
    return c.json({ ok: true })
  })

  app.post(`${base}/research`, async (c) => {
    const t = await target(c)
    return c.json({ run: await startResearch(deps.runs, t, Research.parse(await c.req.json())) }, 202)
  })

  app.put(`${base}/research/domains`, async (c) => {
    const t = await target(c)
    const domains = await setDomains(t, Domains.parse(await c.req.json()).domains, trailer)
    changed(t)
    return c.json({ domains })
  })

  app.post(`${base}/plan/run`, async (c) => c.json({ run: await startPlanner(deps.runs, await target(c)) }, 202))

  // Ruling 9: plan edits never commit.
  app.put(`${base}/plan`, async (c) => {
    const t = await target(c)
    const { slices } = PlanEdit.parse(await c.req.json())
    const statuses = await sliceStatuses(t.wt, await readInitiative(t.ini.dir))
    const doc = await updateInitiative(t.ini.dir, (d) => ({ ...d, plan: editPlan(d.plan, slices, statuses) }))
    changed(t)
    return c.json({ plan: doc.plan })
  })

  app.post(`${base}/plan/approve`, async (c) => {
    const t = await target(c)
    const pending = pendingBlocking((await readReview(t.ini.dir)).decisions).length
    if (pending) throw new HttpError(409, 'decisions_pending', `${pending} blocking decision(s) of the initiative are open`)
    const doc = await updateInitiative(t.ini.dir, (d) => {
      // A planner run in flight could still overwrite the plan it is about to approve (it
      // replaces plan.slices wholesale when it finishes) — refuse until it settles.
      if (d.runs.some((r) => r.kind === 'planner' && r.outcome === 'running')) {
        throw new HttpError(409, 'planner_running', 'The planner is running; wait for it to finish before approving the plan')
      }
      return { ...d, plan: approvePlan(d.plan, nowIso()) }
    })
    const commit = await commitPaths(t.wt.path, [`${t.ini.relDir}/${INITIATIVE_FILE}`],
      initiativeCommitMessage(`${t.ini.name} — slice plan approved (${doc.plan.slices.length} slices)`, trailer))
    changed(t)
    return c.json({ commit })
  })

  app.post(`${base}/slices/:id/propose`, async (c) => {
    const t = await target(c)
    return c.json({ run: await startAuthor(deps.runs, t, c.req.param('id'), Propose.parse(await c.req.json())) }, 202)
  })

  app.post(`${base}/runs/:run/stop`, async (c) => {
    await deps.runs.stop(await target(c), c.req.param('run'))
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/runs/:run/resume`, async (c) => {
    const t = await target(c)
    const run = findRun(await readInitiative(t.ini.dir), c.req.param('run'))
    if (run.kind === 'author') await resumeAuthor(deps.runs, t, run.id)
    else if (run.kind === 'research') await resumeResearch(deps.runs, t, run.id)
    else throw new HttpError(409, 'run_not_waiting', 'A planner run never waits for the owner — run the planner again')
    return c.json({ ok: true }, 202)
  })

  app.get(`${base}/runs/:run/events`, (c) => sseFromBus(c, ctx.bus, `irun:${c.req.param('run')}`))

  app.get(`${base}/runs/:run/log`, async (c) => c.json(await deps.runs.log(await target(c), c.req.param('run'))))
}
