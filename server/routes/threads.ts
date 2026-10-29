import { executeDiscussionCommand } from '../discussion-commands.ts'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { findPhrase, findScenario, loadChangeView } from '../change-view.ts'
import type { ChangeRef, WorktreeInfo } from '../discovery.ts'
import { HttpError } from '../errors.ts'
import { executeGitEffect, withGitEffectLock } from '../git-effect.ts'
import { assertQuestionAvailable, withExecutionLock } from '../review-execution.ts'
import { assertWorktreeAdmission } from '../execution-admission.ts'
import { executePatchCommand, patchAt } from '../patch-commands.ts'
import { preparePatchApplication } from '../patch-application.ts'
import { commitMessage } from '../patch.ts'
import { ownerMessage, type QuestionService, vetPatch } from '../questions.ts'
import {
  newId, readReview, recordReviewEvents, REVIEW_FILE, REVIEW_EVENTS_FILE, type ReviewDoc, type Thread, withReviewLock,
} from '../review-store.ts'
import { assertWritable, relDirOf, resolveChange } from './resolve.ts'
import { sseFromBus } from './sse.ts'

export interface ThreadDeps {
  questions: QuestionService
  applyActive: (worktreePath: string) => boolean
  resumeApply: ((wt: WorktreeInfo, ref: ChangeRef, threadId: string, text?: string) => Promise<void>) | null
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
    await withExecutionLock(wt, ref, async () => {
      await assertQuestionAvailable(wt, ref)
      await executeDiscussionCommand(ref.dir, { type: 'OpenDiscussion', thread: { id, anchor: body.anchor, ref: body.ref, status: 'open', messages: [ownerMessage(body.text)] } })
    })
    void deps.questions.ask(wt, ref, id)
    changed(wt, ref)
    return c.json({ id }, 201)
  })

  app.post(`${base}/:id/messages`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const { text } = Reply.parse(await c.req.json())
    const thread = threadOf(await readReview(ref.dir), id)
    if (thread.anchor === 'apply') {
      if (!deps.resumeApply) throw new HttpError(503, 'apply_unavailable', 'Apply is not available')
      await deps.resumeApply(wt, ref, id, text)
    } else {
      await withExecutionLock(wt, ref, async () => {
        await assertQuestionAvailable(wt, ref)
        await executeDiscussionCommand(ref.dir, { type: 'ReplyToDiscussion', threadId: id, message: ownerMessage(text) })
      })
      void deps.questions.ask(wt, ref, id)
    }
    changed(wt, ref)
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/:id/resolve`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    threadOf(await readReview(ref.dir), id)
    await executeDiscussionCommand(ref.dir, { type: 'ResolveDiscussion', threadId: id })
    changed(wt, ref)
    return c.json({ ok: true })
  })

  app.post(`${base}/:id/patches/:msg/reject`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    await executePatchCommand(ref.dir, { type: 'RejectPatch', threadId: id, index })
    changed(wt, ref)
    return c.json({ ok: true })
  })

  app.post(`${base}/:id/patches/:msg/recheck`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    const patch = threadOf(await readReview(ref.dir), id).messages[index]?.patch
    if (!patch) throw new HttpError(404, 'unknown_patch', `Message ${index} has no patch`)
    if (patch.state !== 'stale') throw new HttpError(409, 'patch_not_stale', 'Only a stale patch can be re-checked')
    const vetted = await vetPatch(wt.path, relDirOf(wt, ref), patch.diff)
    await executePatchCommand(ref.dir, { type: 'RecheckPatch', threadId: id, index, state: vetted.state === 'proposed' ? 'proposed' : 'stale', error: vetted.error, files: vetted.files })
    changed(wt, ref)
    return c.json({ state: vetted.state, error: vetted.error })
  })

  app.post(`${base}/:id/patches/:msg/refresh`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    await withExecutionLock(wt, ref, async () => {
      await assertQuestionAvailable(wt, ref)
      const doc = await readReview(ref.dir)
      const thread = threadOf(doc, id)
      if (thread.anchor === 'apply') throw new HttpError(409, 'patch_refresh_unavailable', 'Apply discussions use the recorded Apply workflow')
      const patch = patchAt(doc, id, index)
      if (patch.state !== 'stale' || patch.effect_id) throw new HttpError(409, 'patch_not_stale', 'Only an unrequested stale patch can be refreshed')
      if (doc.executions.some(run => run.request.role === 'reviewer' && run.request.threadId === id && ['queued', 'running'].includes(run.outcome))) return
      const text = [
        `Обнови устаревший патч из сообщения №${index + 1} этого обсуждения по текущему содержимому файлов.`,
        'Сохрани смысл первоначальной просьбы владельца и все последующие согласованные изменения. Прочитай текущие версии затронутых файлов.',
        'Если файл уже существует, измени его вместо повторного создания. Если исправление уже внесено, объясни это и не предлагай повторный патч.',
        'Верни новый проверяемый diff. Не применяй его, не делай коммит и не меняй историю согласования.',
        `Причина устаревания: ${patch.error ?? 'Патч не применяется к текущим файлам.'}`,
        '', 'Исходный патч:', '```diff', patch.diff.trimEnd(), '```',
      ].join('\n')
      await executeDiscussionCommand(ref.dir, { type: 'ReplyToDiscussion', threadId: id, message: ownerMessage(text) })
    })
    void deps.questions.ask(wt, ref, id)
    changed(wt, ref)
    return c.json({ ok: true }, 202)
  })

  app.post(`${base}/:id/patches/:msg/apply`, async (c) => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    const id = c.req.param('id')
    const index = Number(c.req.param('msg'))
    const { summary } = ApplyBody.parse(await c.req.json())
    if (deps.applyActive(wt.path)) throw new HttpError(409, 'apply_running', 'An Apply run is active in this worktree - wait for it to finish.')
    const receipt = await withGitEffectLock(wt.path, () => withReviewLock(ref.dir, async () => {
      const doc = await readReview(ref.dir)
      const patch = patchAt(doc, id, index)
      let plan = patch.effect_id ? doc.git_effects.find(effect => effect.plan.effectId === patch.effect_id)?.plan : undefined
      await assertWorktreeAdmission(wt.path, { operation: 'git', effectId: plan?.effectId })
      if (patch.effect_id && !plan) throw new HttpError(409, 'patch_effect_missing', 'The recorded patch application has no Git effect')
      if (!plan) {
        if (patch.state !== 'proposed') throw new HttpError(409, 'patch_not_proposed', 'Only a proposed patch can be applied')
        const vetted = await vetPatch(wt.path, relDirOf(wt, ref), patch.diff)
        if (vetted.state !== 'proposed') {
          await executePatchCommand(ref.dir, { type: 'RecheckPatch', threadId: id, index, state: 'stale', error: vetted.error, files: vetted.files })
          changed(wt, ref)
          throw new HttpError(409, 'patch_stale', vetted.error ?? 'The patch no longer applies')
        }
        const rel = relDirOf(wt, ref)
        plan = await preparePatchApplication(wt.path, vetted, `${id}:${index}`, commitMessage(ref.name, summary, ctx.config.commitTrailer), [`${rel}/${REVIEW_FILE}`, `${rel}/${REVIEW_EVENTS_FILE}`])
        await executePatchCommand(ref.dir, { type: 'RequestPatchApplication', threadId: id, index, effect: plan })
      }
      // A retry may follow projection loss. Rebuild only the derived file before Git stages it.
      await recordReviewEvents(ref.dir, async () => ({ events: [] }), 'patch-command')
      const result = await executeGitEffect(wt.path, plan, { resumePending: true })
      await executePatchCommand(ref.dir, { type: 'RecordPatchApplicationReceipt', threadId: id, index, receipt: result })
      return result
    }))
    changed(wt, ref)
    if (receipt.status !== 'completed') throw new HttpError(409, `patch_application_${receipt.status}`, receipt.reason)
    return c.json({ commit: receipt.commit })
  })

  app.get(`${base}/:id/events`, (c) => sseFromBus(c, ctx.bus, `thread:${c.req.param('id')}`))
  app.post('/api/changes/:wt/:name/executions/:run/resume', async c => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    await deps.questions.resume(wt, ref, c.req.param('run'))
    return c.json({ ok: true }, 202)
  })
  app.post('/api/changes/:wt/:name/executions/:run/stop', async c => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    await deps.questions.stop(wt, ref, c.req.param('run'))
    return c.json({ ok: true }, 202)
  })
  app.post('/api/changes/:wt/:name/executions/recover', async c => {
    const { wt, ref } = await target(c.req.param('wt'), c.req.param('name'))
    await deps.questions.recover(wt, ref)
    return c.json({ ok: true })
  })
}
