import type { Hono } from 'hono'
import { z } from 'zod'
import type { AppContext } from '../app.ts'
import { executeApprovalCommand, readApprovalFacts, type ApprovalCommand } from '../approval-commands.ts'
import { commitFiles } from '../git.ts'
import type { QuestionService } from '../questions.ts'
import { newId, REVIEW_FILE } from '../review-store.ts'
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
    return { wt, ref }
  }
  const done = (wtId: string, name: string) => ctx.bus.publish('change', { worktreeId: wtId, name })

  app.post(`${base}/scenarios/approve`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'ApproveScenario', key }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/scenarios/revoke`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'RevokeScenario', key }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/scenarios/request-changes`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key, reason } = RequestChanges.parse(await c.req.json())
    const threadId = newId('t')
    const command: ApprovalCommand = { type: 'RequestScenarioChanges', key, reason, threadId }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    void deps.questions.ask(wt, ref, threadId)
    done(wt.id, ref.name)
    return c.json({ threadId })
  })

  app.post(`${base}/phrases/approve`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'ApprovePhrase', key }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/phrases/revoke`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { key } = Key.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'RevokePhrase', key }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/approval`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const command: ApprovalCommand = { type: 'RecordChangeApproval' }
    const trailer = ctx.config.commitTrailer ? `\n\n${ctx.config.commitTrailer}` : ''
    const commit = await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command),
      () => commitFiles(wt.path, [`${relDirOf(wt, ref)}/${REVIEW_FILE}`], `docs(openspec): ${ref.name} - owner approval${trailer}\n`))
    done(wt.id, ref.name)
    return c.json({ commit })
  })

  app.post(`${base}/orphans/drop`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { section, key } = Orphan.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'DropOrphanReview', section, key }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })

  app.post(`${base}/orphans/reattach`, async (c) => {
    const { wt, ref } = await load(c.req.param('wt'), c.req.param('name'))
    const { section, key, to } = Reattach.parse(await c.req.json())
    const command: ApprovalCommand = { type: 'ReattachOrphanReview', section, key, to }
    await executeApprovalCommand(ref.dir, command, () => readApprovalFacts(wt, ref, command))
    done(wt.id, ref.name)
    return c.json({ ok: true })
  })
}
