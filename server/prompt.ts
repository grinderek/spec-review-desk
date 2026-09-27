import type { DecisionRecord, Message } from './review-store.ts'

export interface QuestionPromptInput {
  changeName: string
  relDir: string
  anchor: { kind: 'scenario' | 'phrase' | 'change' | 'apply'; ref: string; text: string }
  messages: readonly Message[]
  files: readonly string[]
  today: string
  decisions?: readonly DecisionRecord[]
  scenarioKeys?: readonly string[]
}

const HEADINGS = { scenario: 'Scenario', phrase: 'Step phrase', change: 'Change', apply: 'Apply run' } as const
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

const scopeText = (d: DecisionRecord): string => (d.scope.kind === 'scenario' ? `scenario ${d.scope.key}` : 'the whole change')

function choiceText(d: DecisionRecord): string {
  const option = d.options.find((o) => o.id === d.choice?.option)
  const label = option ? `${option.id} (${option.label})` : 'no option'
  return d.choice?.note ? `${label}; note: ${d.choice.note}` : label
}

// Final review Important 1(a): agents were never shown the scenario keys that `scope.key` must
// echo verbatim (spec §7's key format, `<feature file>::<scenario title>`, gherkin.ts scenarioKey),
// so a scenario-scoped decision mostly failed validation with an invented key. Listing every key
// here — in both the question prompt and the Apply prompt — gives the agent something to copy.
export function scenarioKeysSection(keys: readonly string[]): string[] {
  if (keys.length === 0) return []
  return ['## Scenario keys', 'Copy one of these verbatim into decisions[].scope.key — never invent one:', ...keys.map((k) => `- ${k}`)]
}

// Spec §7: every agent prompt lists the change's open and decided decisions, so agents neither
// re-ask them nor lose the owner's choice.
export function decisionsSection(decisions: readonly DecisionRecord[]): string[] {
  const listed = decisions.filter((d) => d.status === 'open' || d.status === 'decided')
  if (listed.length === 0) return ['## Decisions', 'No open or decided decisions.']
  return [
    '## Decisions',
    ...listed.map((d) => {
      const head = `- ${d.id} [${d.status}${d.blocking ? ', blocking' : ''}] ${scopeText(d)} — ${d.question}`
      return d.status === 'decided'
        ? `${head}\n  Owner's choice: ${choiceText(d)}`
        : `${head}\n  Options: ${d.options.map((o) => o.id).join(', ') || 'none'}`
    }),
  ]
}

export function buildQuestionPrompt(input: QuestionPromptInput): string {
  const history = input.messages
    .map((m) => `${m.role === 'owner' ? 'OWNER' : 'YOU (earlier answer)'} — ${m.at}\n${m.text}`)
    .join('\n\n')
  return [
    `Change: ${input.changeName} (directory ${input.relDir}/). Today is ${input.today}.`,
    `The owner is reviewing this change and asks about the ${HEADINGS[input.anchor.kind].toLowerCase()} below.`,
    '',
    `## ${HEADINGS[input.anchor.kind]}: ${input.anchor.ref}`,
    '```',
    input.anchor.text,
    '```',
    '',
    '## Review files',
    ...input.files.map((f) => `- ${f}`),
    '',
    ...scenarioKeysSection(input.scenarioKeys ?? []),
    ...(input.scenarioKeys?.length ? [''] : []),
    ...decisionsSection(input.decisions ?? []),
    '',
    '## Thread so far',
    history,
    '',
    'Answer the last OWNER message.',
  ].join('\n')
}

// Spec §8: "Resume with decisions" tells the Apply agent what the owner chose for each decision of
// its run.
export function buildResumePrompt(decisions: readonly DecisionRecord[]): string {
  const line = (d: DecisionRecord): string => {
    if (d.status === 'dismissed') return `- ${d.id} (${d.question}): dismissed — ${d.dismissed?.reason ?? ''}`
    if (d.status === 'open') return `- ${d.id} (${d.question}): still open and not blocking — continue without it`
    const option = d.options.find((o) => o.id === d.choice?.option)
    const choice = sentence(option ? `${option.label} — ${option.consequence}` : '(no option)')
    const note = d.choice?.note ? ` Note: ${sentence(d.choice.note)}` : ''
    const where = d.recorded?.how === 'patch'
      ? ` Recorded in the scenario by ${d.recorded.commit ?? 'a patch'}.`
      : d.recorded?.how === 'decisions_md' ? ' Recorded in decisions.md.' : ''
    return `- ${d.id} (${d.question}): ${choice}${note}${where}`
  }
  return ['The owner answered the decisions you raised:', ...decisions.map(line), '', 'Continue the apply with these choices.'].join('\n')
}
