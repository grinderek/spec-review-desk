import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { findPhrase, findScenario, loadChangeView } from '../change-view.ts'
import type { ChangeRef, WorktreeInfo } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { commitFiles, resetStaged } from '../git.ts'
import { applyPatch, commitMessage, revertPatch } from '../patch.ts'
import { ownerMessage, type QuestionService, vetPatch } from '../questions.ts'
import {
  addThread, appendMessage, newId, readReview, REVIEW_FILE, type ReviewDoc, setThreadStatus, type Thread, updatePatch, updateReview,
} from '../review-store.ts'
import { assertWritable, relDirOf, resolveChange } from './resolve.ts'
import { sseFromBus } from './sse.ts'

export interface ThreadDeps {
  questions: QuestionService
  applyActive: (worktreePath: string) => boolean
  resumeApply: ((wt: WorktreeInfo, ref: ChangeRef, threadId: string) => Promise<void>) | null
}

const NewThread = z.object({ anchor: z.enum(['scenario', 'phrase', 'change']), ref: z.string(), text: z.string().trim().min(1) })
const Reply = z.object({ text: z.string().trim().min(1) })
const ApplyBody = z.object({ summary: z.string().trim().min(1).max(120) })

function threadOf(doc: ReviewDoc, id: string): Thread {
  const thread = doc.threads.find((t) => t.id === id)
  if (!thread) throw new HttpError(404, 'unknown_thread', `No thread ${id}`)
  return thread
}

export function registerThreadRoutes(app: Hono, ctx: AppContext, deps: ThreadDeps): void {
  const base = '/api/changes/:wt/:name/threads'
  const target = async (wtId: string, name: string) => {
    const resolved = await resolveChange(ctx, wtId, name)
    assertWritable(resolved.ref)
    return resolved
  }
  const changed = (wt: WorktreeInfo, ref: ChangeRef) => ctx.bus.publish('change', { worktreeId: wt.id, name: ref.name })

  app.post(base, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const body = NewThread.parse(await c.req.json())
    const view = await loadChangeView(wt, ref, { withCommits: false })
    if (body.anchor === 'scenario' && !findScenario(view, body.ref)) throw new HttpError(404, 'unknown_scenario', `No scenario ${body.ref}`)
    if (body.anchor === 'phrase' && !findPhrase(view, body.ref)) throw new HttpError(404, 'unknown_phrase', `No phrase ${body.ref}`)
    const id = newId('t')
    await updateReview(ref.dir, (doc) => addThread(doc, { id, anchor: body.anchor, ref: body.ref, status: 'open', messages: [ownerMessage(body.text)] }))
    void deps.questions.ask(wt, ref, id)
    changed(wt, ref)
    return c.json({ id }, 201)
  })

  app.post(`${base}/:id/messages`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const { text } = Reply.parse(await c.req.json())
    const thread = threadOf(await readReview(ref.dir), id)
    await updateReview(ref.dir, (doc) => setThreadStatus(appendMessage(doc, id, ownerMessage(text)), id, 'open'))
    if (thread.anchor === 'apply') {
      if (!deps.resumeApply) throw new HttpError(503, 'apply_unavailable', 'Apply is not available')
      void deps.resumeApply(wt, ref, id)
    } else {
      void deps.questions.ask(wt, ref, id)
    }
    changed(wt, ref)
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/:id/resolve`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    threadOf(await readReview(ref.dir), id)
    await updateReview(ref.dir, (doc) => setThreadStatus(doc, id, 'resolved'))
    changed(wt, ref)
    return c.json({ ok: true })
  })

  app.post(`${base}/:id/patches/:msg/reject`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    const message = threadOf(await readReview(ref.dir), id).messages[index]
    if (!message?.patch) throw new HttpError(404, 'unknown_patch', `Message ${index} has no patch`)
    await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { state: 'rejected' }))
    changed(wt, ref)
    return c.json({ ok: true })
  })

  app.post(`${base}/:id/patches/:msg/apply`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    const { summary } = ApplyBody.parse(await c.req.json())
    if (deps.applyActive(wt.path)) throw new HttpError(409, 'apply_running', 'An Apply run is active in this worktree — wait for it to finish.')
    const patch = threadOf(await readReview(ref.dir), id).messages[index]?.patch
    if (!patch || patch.state !== 'proposed') throw new HttpError(409, 'patch_not_proposed', 'Only a proposed patch can be applied')
    const relDir = relDirOf(wt, ref)
    const vetted = await vetPatch(wt.path, relDir, patch.diff)
    if (vetted.state !== 'proposed') {
      await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { state: 'stale', error: vetted.error }))
      changed(wt, ref)
      throw new HttpError(409, 'patch_stale', vetted.error ?? 'The patch no longer applies')
    }
    await applyPatch(wt.path, patch.diff)
    await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { state: 'applied', files: vetted.files }))
    const staged = [...vetted.files, `${relDir}/${REVIEW_FILE}`]
    let sha: string
    try {
      sha = await commitFiles(wt.path, staged, commitMessage(ref.name, summary, ctx.config.commitTrailer))
    } catch (error) {
      try {
        await resetStaged(wt.path, staged)
        await revertPatch(wt.path, patch.diff)
        await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { state: 'proposed' }))
      } catch (revertError) {
        await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { state: 'stale', error: (revertError as Error).message }))
      }
      throw error
    }
    await updateReview(ref.dir, (doc) => updatePatch(doc, id, index, { commit: sha }))
    changed(wt, ref)
    return c.json({ commit: sha })
  })

  app.get(`${base}/:id/events`, (c) => sseFromBus(c, ctx.bus, `thread:${c.req.param('id')}`))
}
