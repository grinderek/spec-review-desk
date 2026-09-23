import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { findPhrase, findScenario, loadChangeView } from '../change-view.ts'
import { HttpError } from '../errors.ts'
import { commitFiles, headSha } from '../git.ts'
import { ownerMessage, type QuestionService } from '../questions.ts'
import { addThread, moveEntry, newId, nowIso, recordApproval, REVIEW_FILE, setEntry, updateReview } from '../review-store.ts'
import { assertWritable, relDirOf, resolveChange } from './resolve.ts'

const Key = z.object({ key: z.string().min(1) })
const RequestChanges = z.object({ key: z.string().min(1), reason: z.string().trim().min(1) })
const Orphan = z.object({ section: z.enum(['scenarios', 'phrases']), key: z.string().min(1) })
const Reattach = Orphan.extend({ to: z.string().min(1) })

export function registerReviewRoutes(app: Hono, ctx: AppContext, deps: { questions: QuestionService }): void {
  const base = '/api/changes/:wt/:name'
  const load = async (wtId: string, name: string) => {
    const { wt, ref } = await resolveChange(ctx, wtId, name)
    assertWritable(ref)
    const view = await loadChangeView(wt, ref, { withCommits: false })
    return { wt, ref, view }
  }
  const done = (wtId: string, name: string) => ctx.bus.publish('change', { worktreeId: wtId, name })

  app.post(`${base}/scenarios/approve`, async (c) => {
    const { wt, ref, view } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const scenario = findScenario(view, key)
    if (!scenario) throw new HttpError(404, 'unknown_scenario', `No scenario ${key}`)
    const commit = await headSha(wt.path)
    await updateReview(ref.dir, (doc) => setEntry(doc, 'scenarios', key, { status: 'approved', text_hash: scenario.hash, approved_commit: commit, at: nowIso() }))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/scenarios/revoke`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    await updateReview(ref.dir, (doc) => setEntry(doc, 'scenarios', key, null))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/scenarios/request-changes`, async (c) => {
    const { wt, ref, view } = await load(c.req.param('wt'), c.req.param('name'))
    const { key, reason } = RequestChanges.parse(await c.req.json())
    const scenario = findScenario(view, key)
    if (!scenario) throw new HttpError(404, 'unknown_scenario', `No scenario ${key}`)
    const threadId = newId('t')
    await updateReview(ref.dir, (doc) =>
      addThread(
        setEntry(doc, 'scenarios', key, { status: 'changes_requested', text_hash: scenario.hash, approved_commit: null, at: nowIso() }),
        { id: threadId, anchor: 'scenario', ref: key, status: 'open', messages: [ownerMessage(reason)] },
      ),
    )
    void deps.questions.ask(wt, ref, threadId)
    done(wt.id, ref.name)
    return c.json({ threadId })
  })

  app.post(`${base}/phrases/approve`, async (c) => {
    const { wt, ref, view } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const phrase = findPhrase(view, key)
    if (!phrase) throw new HttpError(404, 'unknown_phrase', `No phrase ${key}`)
    await updateReview(ref.dir, (doc) => setEntry(doc, 'phrases', key, { status: 'approved', text_hash: phrase.hash, approved_commit: null, at: nowIso() }))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/phrases/revoke`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    await updateReview(ref.dir, (doc) => setEntry(doc, 'phrases', key, null))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/approval`, async (c) => {
    const { wt, ref, view } = await load(c.req.param('wt'), c.req.param('name'))
    if (!view.readiness.ready) throw new HttpError(409, 'not_ready', `Not ready: ${view.readiness.reasons.join('; ')}`)
    const head = await headSha(wt.path)
    await updateReview(ref.dir, (doc) => recordApproval(doc, nowIso(), head))
    const trailer = ctx.config.commitTrailer ? `\n\n${ctx.config.commitTrailer}` : ''
    const commit = await commitFiles(wt.path, [`${relDirOf(wt, ref)}/${REVIEW_FILE}`], `docs(openspec): ${ref.name} — owner approval${trailer}\n`)
    done(wt.id, ref.name)
    return c.json({ commit })
  })

  app.post(`${base}/orphans/drop`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { section, key } = Orphan.parse(await c.req.json())
    await updateReview(ref.dir, (doc) => setEntry(doc, section, key, null))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/orphans/reattach`, async (c) => {
    const { wt, ref, view } = await load(c.req.param('wt'), c.req.param('name'))
    const { section, key, to } = Reattach.parse(await c.req.json())
    const exists = section === 'scenarios' ? findScenario(view, to) : findPhrase(view, to)
    if (!exists) throw new HttpError(404, 'unknown_target', `No ${section === 'scenarios' ? 'scenario' : 'phrase'} ${to}`)
    await updateReview(ref.dir, (doc) => {
      if (!doc[section][key]) throw new HttpError(404, 'unknown_entry', `No review entry ${key}`)
      return moveEntry(doc, section, key, to)
    })
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })
}
