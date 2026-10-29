import { isDeepStrictEqual } from 'node:util'
import { normalizeDomain } from './egress.ts'
import { HttpError } from './errors.ts'
import { type InitiativeEventPayload, type InitiativeEvent, readInitiativeStream, recordInitiativeEvents } from './initiative-events.ts'
import { findSlice, readInitiative, withInitiativeLock, type InitiativeDoc, type InputEntry, type Slice } from './initiative-store.ts'
import { approvePlan, editPlan, type SliceEdit, type SliceStatus } from './slice-plan.ts'

export type InitiativeCommand =
  | { type: 'save-brief'; blob: string }
  | { type: 'add-inputs'; inputs: InputEntry[] }
  | { type: 'accept-input' | 'discard-input'; file: string }
  | { type: 'set-domains'; domains: readonly string[] }
  | { type: 'grant-domains'; domains: readonly string[]; decision: string; commit: string }
  | { type: 'draft-plan'; slices: Slice[]; run: string; attempt?: string }
  | { type: 'edit-plan'; slices: readonly SliceEdit[]; statuses: Readonly<Record<string, SliceStatus>> }
  | { type: 'approve-plan'; pending: number }
  | { type: 'associate-change'; slice: string; change: string | null }

export function decideInitiative(doc: InitiativeDoc, command: InitiativeCommand, at: string, history: readonly InitiativeEvent[]): InitiativeEventPayload[] {
  switch (command.type) {
    case 'save-brief': {
      const latest = history.reduce<string | null>((blob, { event }) => event.type === 'InitiativeCreated' ? event.brief : event.type === 'InitiativeBriefSaved' ? event.blob : blob, null)
      return latest === command.blob ? [] : [{ type: 'InitiativeBriefSaved', blob: command.blob }]
    }
    case 'add-inputs': {
      const used = new Set(doc.inputs.map(i => i.file))
      for (const input of command.inputs) {
        if (used.has(input.file)) throw new HttpError(409, 'input_exists', `Input ${input.file} already exists`)
        used.add(input.file)
      }
      return command.inputs.map(input => ({ type: 'InitiativeInputAdded', input }))
    }
    case 'accept-input':
    case 'discard-input': {
      const input = doc.inputs.find(i => i.file === command.file)
      if (!input) throw new HttpError(404, 'unknown_input', `No input ${command.file}`)
      if (!input.draft) throw new HttpError(409, 'not_a_draft', `${command.file} is not a research draft`)
      return [{ type: command.type === 'accept-input' ? 'ResearchInputAccepted' : 'ResearchInputDiscarded', file: input.file }]
    }
    case 'set-domains':
    case 'grant-domains': {
      const domains = [...new Set(command.domains.map(domain => {
        const host = normalizeDomain(domain)
        if (!host) throw new HttpError(422, 'invalid_domain', `"${domain}" is not a plain hostname`)
        return host
      }))]
      if (command.type === 'grant-domains') {
        const previous = history.find(({ event }) => event.type === 'ResearchDomainsGranted' && event.decision === command.decision)?.event
        if (previous?.type === 'ResearchDomainsGranted') {
          if (!isDeepStrictEqual(previous.domains, domains) || previous.commit !== command.commit) throw new HttpError(409, 'grant_conflict', 'This owner decision already granted different research permissions')
          return []
        }
        return [{ type: 'ResearchDomainsGranted', domains, decision: command.decision, commit: command.commit }]
      }
      return isDeepStrictEqual(domains, doc.research.domains) ? [] : [{ type: 'ResearchDomainsSet', domains }]
    }
    case 'draft-plan':
      if (doc.plan.status === 'approved') throw new HttpError(409, 'plan_approved', 'The slice plan is approved')
      return [{ type: 'SlicePlanDrafted', slices: command.slices, run: command.run, ...(command.attempt ? {attempt:command.attempt} : {}) }]
    case 'edit-plan': {
      const plan = editPlan(doc.plan, command.slices, command.statuses)
      return isDeepStrictEqual(plan, doc.plan) ? [] : [{ type: 'SlicePlanEdited', slices: plan.slices }]
    }
    case 'approve-plan': {
      if (command.pending) throw new HttpError(409, 'decisions_pending', `${command.pending} blocking decision(s) of the initiative are open`)
      if (doc.runs.some(r => r.kind === 'planner' && ['running','queued','uncertain'].includes(r.outcome))) throw new HttpError(409, 'planner_running', 'The planner has unresolved execution state')
      const plan = approvePlan(doc.plan, at)
      return [{ type: 'SlicePlanApproved', slices: plan.slices, approved_at: at }]
    }
    case 'associate-change': {
      const slice = findSlice(doc, command.slice)
      return slice.change === command.change ? [] : [{ type: 'SliceChangeAssociated', slice: slice.id, change: command.change }]
    }
  }
}

export function executeInitiativeCommand(dir: string, command: InitiativeCommand, at = new Date().toISOString()): Promise<InitiativeDoc> {
  return withInitiativeLock(dir, async () => {
    const history = await readInitiativeStream(dir)
    const doc = await readInitiative(dir)
    const pending=doc.git_effects.find(effect=>effect.status!=='completed')
    if(pending)throw new HttpError(409,'initiative_git_pending',`Finish recorded effect ${pending.plan.effectId} before changing initiative state`)
    if ((await readInitiativeStream(dir)).version !== history.version) throw new HttpError(409, 'initiative_conflict', 'Initiative changed; retry command')
    return recordInitiativeEvents(dir, history, decideInitiative(doc, command, at, history.events), at, doc.runs)
  })
}
