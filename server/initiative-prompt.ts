import type { InitiativeDoc, Slice } from './initiative-store.ts'
import { decisionsSection } from './prompt.ts'
import type { DecisionRecord } from './review-store.ts'
import { WORK_OUT } from './sandbox-args.ts'

// Prompts of the sandboxed agents (spec B §4). The rules (prompts/<kind>.md) go in as the
// appended system prompt; these are the stdin prompts.
const ROOM = [
  '## The room (read-only, your working directory)',
  '- initiative/brief.md — what, why and out of scope, written by the owner',
  '- initiative/inputs/ — documents the owner provided or accepted',
  '- initiative/decisions.md — decisions the owner already took',
  '- initiative/plan.yaml — the slice plan with each slice status',
  '- slices/<change>/ — earlier slices of this initiative (proposal, specs, features, NEW_STEPS.md, decisions)',
  '- corpus/features/ and corpus/specs/ — the living behavior of the repository',
  '- method/ — how a behavior-driven change is written (Spec-driven work, testing rules, the schema)',
]

const header = (doc: InitiativeDoc): string => `Initiative: ${doc.name} — ${doc.title} (repository ${doc.repo}).`

export function plannerPrompt(doc: InitiativeDoc, decisions: readonly DecisionRecord[]): string {
  return [
    header(doc),
    '',
    ...ROOM,
    '',
    'Propose how to slice this initiative into 1 to 12 behavior-driven changes, in the order they should be',
    'built. Each slice must be small enough to review scenario by scenario and to apply on its own.',
    '',
    ...decisionsSection(decisions),
  ].join('\n')
}

export function authorPrompt(doc: InitiativeDoc, slice: Slice, notes: string, change: string, decisions: readonly DecisionRecord[]): string {
  return [
    header(doc),
    '',
    ...ROOM,
    '',
    `## Slice ${slice.id} — ${slice.title}`,
    slice.scope,
    `Depends on: ${slice.depends_on.join(', ') || 'nothing'}`,
    `Owner notes: ${notes.trim() || '—'}`,
    '',
    `Write the change \`${change}\` into ${WORK_OUT}/openspec/changes/${change}/ and nowhere else:`,
    '.openspec.yaml (schema: behavior-driven), proposal.md, specs/<capability>/spec.md, features/*.feature and',
    'features/NEW_STEPS.md. Set `change` in your reply to exactly this name.',
    '',
    ...decisionsSection(decisions),
  ].join('\n')
}

export function researchPrompt(doc: InitiativeDoc, topic: string, questions: string): string {
  return [
    header(doc),
    '',
    'The room holds initiative/brief.md and the accepted inputs under initiative/inputs/.',
    '',
    `Topic: ${topic}`,
    '## Questions',
    questions.trim(),
    '',
    `Already allowed for WebFetch: ${doc.research.domains.join(', ') || 'none'}`,
    'You have WebSearch only. When you need to read pages, reply needs_owner with the fetch-domains decision.',
  ].join('\n')
}

export function researchResumeClosing(domains: readonly string[]): string {
  return domains.length
    ? `WebFetch is now enabled for: ${domains.join(', ')}. Read the pages you need and reply with the finished document.`
    : 'WebFetch stays disabled (search only). Write the document from the search results and reply with it.'
}
