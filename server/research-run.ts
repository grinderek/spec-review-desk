import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { slugify } from './author-run.ts'
import { addDecisions, decisionsFromReply, runDecisions } from './decision-model.ts'
import { FETCH_DOMAINS, normalizeDomain } from './egress.ts'
import { researchPrompt, researchResumeClosing } from './initiative-prompt.ts'
import { findRun, type InputEntry, readInitiative, type RunRecord } from './initiative-store.ts'
import { buildResumePrompt } from './prompt.ts'
import { readReview, updateReview } from './review-store.ts'
import type { Finisher, InitiativeRunService, RunTarget } from './run-service.ts'

// Spec B §4.5: research in two phases — WebSearch only, then (after the owner's fetch-domains
// decision) WebFetch limited to the approved domains. The result is a draft input.
export async function startResearch(service: InitiativeRunService, target: RunTarget, input: { topic: string; questions: string }): Promise<RunRecord> {
  await service.requireReady()
  const doc = await readInitiative(target.ini.dir)
  return service.begin(
    target,
    { kind: 'research', topic: input.topic, questions: input.questions, phase: 'search', web_fetch: false },
    researchPrompt(doc, input.topic, input.questions),
  )
}

const ALREADY_ALLOWED = 'All the domains you asked for are already allowed.'

// A run already in a reading phase keeps reading: it waits either for a second fetch-domains decision
// (asset hosts) or — with every domain already allowed — for the browser image (controller ruling 1).
export async function resumeResearch(service: InitiativeRunService, target: RunTarget, runId: string): Promise<void> {
  const fetch = runDecisions(await readReview(target.ini.dir), runId).find((d) => d.requested_domains)
  const doc = await readInitiative(target.ini.dir)
  const run = findRun(doc, runId)
  const approved = fetch?.status === 'recorded' && fetch.choice?.option !== 'search_only'
  const webFetch = (approved || (run.phase === 'read' && run.web_fetch === true)) && doc.research.domains.length > 0
  const closing = researchResumeClosing(webFetch ? doc.research.domains : [])
  const prompt = (decisions: Parameters<typeof buildResumePrompt>[0]): string =>
    decisions.length ? buildResumePrompt(decisions, closing) : `${ALREADY_ALLOWED} ${closing}`
  await service.resumeRun(target, runId, { phase: 'read', web_fetch: webFetch }, prompt)
}

// research-<topic>.md, with -2, -3, … when an input of that name exists.
export function researchFileName(topic: string, taken: readonly string[]): string {
  const base = `research-${slugify(topic) || 'topic'}`
  const used = new Set(taken)
  if (!used.has(`${base}.md`)) return `${base}.md`
  let n = 2
  while (used.has(`${base}-${n}.md`)) n += 1
  return `${base}-${n}.md`
}

export const finishResearch: Finisher<'research'> = async (ctx, reply) => {
  if (reply.status === 'failed') return ctx.record('failed', reply.answer)
  const { ini } = ctx.target
  const doc = await readInitiative(ini.dir)
  if (reply.status === 'needs_owner') {
    const decision = reply.decisions.find((d) => d.id === FETCH_DOMAINS.id)!
    const requested = [...new Set(decision.requested_domains.map((h) => normalizeDomain(h)!))]
    const allowed = new Set(doc.research.domains)
    if (requested.every((h) => allowed.has(h))) {
      // Ruling 2: every requested domain is already approved — continue without asking.
      return ctx.relaunch({ phase: 'read', web_fetch: true, validation_retry: false }, `${ALREADY_ALLOWED} ${researchResumeClosing(doc.research.domains)}`)
    }
    const [record] = decisionsFromReply([decision], { kind: 'run', run: ctx.run.id, agent: 'research' }, ctx.at)
    await updateReview(ini.dir, (d) => addDecisions(d, [{ ...record!, requested_domains: requested }]))
    return ctx.record('needs_owner', reply.answer)
  }
  const inputsDir = path.join(ini.dir, 'inputs')
  await mkdir(inputsDir, { recursive: true })
  const file = researchFileName(ctx.run.topic ?? '', [...doc.inputs.map((i) => i.file), ...(await readdir(inputsDir))])
  const body = reply.document.endsWith('\n') ? reply.document : `${reply.document}\n`
  await writeFile(path.join(inputsDir, file), body)
  const entry: InputEntry = {
    file,
    bytes: Buffer.byteLength(body),
    source: { kind: 'research', run: ctx.run.id, domains: ctx.run.web_fetch ? doc.research.domains : [] },
    added_at: ctx.at,
    draft: true,
  }
  await ctx.record('done', reply.answer, undefined, (d) => ({ ...d, inputs: [...d.inputs, entry] }))
}
