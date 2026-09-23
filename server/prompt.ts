import type { Message } from './review-store.ts'

export interface QuestionPromptInput {
  changeName: string
  relDir: string
  anchor: { kind: 'scenario' | 'phrase' | 'change' | 'apply'; ref: string; text: string }
  messages: readonly Message[]
  files: readonly string[]
  today: string
}

const HEADINGS = { scenario: 'Scenario', phrase: 'Step phrase', change: 'Change', apply: 'Apply run' } as const

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
    '## Thread so far',
    history,
    '',
    'Answer the last OWNER message.',
  ].join('\n')
}
