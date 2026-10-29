import type { InitiativeDoc, Slice } from './initiative-store.ts'
import { decisionsSection } from './prompt.ts'
import type { DecisionRecord } from './review-store.ts'
import { WORK_OUT } from './sandbox-args.ts'

// Prompts of the sandboxed agents (spec B §4). The rules (prompts/<kind>.md) go in as the
// appended system prompt; these are the stdin prompts.
const ROOM = [
  '## The room (read-only, your working directory)',
  '- initiative/brief.md - what, why and out of scope, written by the owner',
  '- initiative/inputs/ - documents the owner provided or accepted',
  '- initiative/decisions.md - decisions the owner already took',
  '- initiative/plan.yaml - the slice plan with each slice status',
  '- slices/<change>/ - earlier slices of this initiative (change.yaml, contracts.md, features, NEW_STEPS.md, decisions)',
  '- corpus/features/ and corpus/contracts.md - the living behavior of the repository',
  '- method/ - how a behavior-driven change is written: bdd-event-sourcing.md (the shape every scenario',
  '  keeps: Given events, one When, Then response/page + events), repository instructions and testing rules',
]

const header = (doc: InitiativeDoc): string => `Initiative: ${doc.name} - ${doc.title} (repository ${doc.repo}).`

function existingProcessContext(doc: InitiativeDoc): string[] {
  if (!doc.existingProcess) return []
  return [
    '## Describe an existing product process',
    `Product: ${doc.existingProcess.product}. Process: ${doc.existingProcess.process}.`,
    `Boundary: ${doc.existingProcess.boundary}`,
    'Read implementation/index.json and the referenced implementation/<index>/ files. These are immutable committed source snapshots, not live checkouts.',
    'Trace public entry points, actual commands, persistence, consumers and UI observations across components. Cite exact repository, path, commit and line.',
    'Observed code is evidence, not owner-approved desired behavior. Distinguish observed behavior, unknowns and proposed owner decisions. Do not invent effects or execute production commands.',
    'Write compact Russian owner-facing rules. Reuse the current corpus and step vocabulary, with small tables for meaningful variants.',
    'The inspected code may use CRUD. Do not require new event sourcing inside applications or fabricate events in an adapter.',
    'Do not change application code, adapt expectations to force green results, claim unexecuted verification, or create approvals.',
  ]
}

export function plannerPrompt(doc: InitiativeDoc, decisions: readonly DecisionRecord[]): string {
  return [
    header(doc),
    '',
    ...ROOM,
    ...existingProcessContext(doc),
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
    ...existingProcessContext(doc),
    '',
    `## Slice ${slice.id} - ${slice.title}`,
    slice.scope,
    `Depends on: ${slice.depends_on.join(', ') || 'nothing'}`,
    `Owner notes: ${notes.trim() || '-'}`,
    '',
    `Write the change \`${change}\` into ${WORK_OUT}/desk/changes/${change}/ and nowhere else:`,
    'change.yaml (version: 1, kind: behavior-driven), executable features/**/*.desk.yaml or',
    'features/**/*.feature with explicit @id:<stable-id> tags. Prose is optional; Gherkin may add',
    'features/NEW_STEPS.md. Set `change` in your reply to exactly this name.',
    ...(doc.existingProcess ? [
      'Include implementation-references.yaml: version: 1; sources: [{rule: "relative-feature-path::stable-id", repo: "configured repository name", path: "exact source file path", line: 1, end_line: 5}].',
      'Use rule identities relative to features/, exactly one explicit @id tag per Gherkin scenario. Every rule must have at least one valid reference into implementation/index.json.',
      'proposal.md must explain observed behavior, uncertainties and adapter operations needed to execute these rules. New steps require implementation before verification can pass.',
      'Do not create an adapter or technical tests in this authoring run; your only writable output is the review package.',
    ] : []),
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
    `Already allowed for desk.read_web_page and the browser: ${doc.research.domains.join(', ') || 'none'}`,
    'You have desk.search_web only. When you need to read pages, reply needs_owner with the fetch-domains decision.',
  ].join('\n')
}

// Review fix 3: the owner answered a later fetch-domains decision (e.g. asset hosts) with search only.
export const RESEARCH_READING_STOPPED =
  'The owner chose search only: desk.read_web_page and the browser are now off. Write the document from what you have already read and the ' +
  'search results, and reply with it.'

export function researchResumeClosing(domains: readonly string[]): string {
  return domains.length
    ? `desk.read_web_page is now enabled for: ${domains.join(', ')}. The browser (the browser MCP tools) reaches the same hosts: use it for ` +
      'pages that desk.read_web_page returns empty. Read the pages you need and reply with the finished document.'
    : 'desk.read_web_page stays disabled (search only). Write the document from the search results and reply with it.'
}
