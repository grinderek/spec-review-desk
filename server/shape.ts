import type { StepKeyword, StepView } from './gherkin.ts'

// The event-sourcing shape of a scenario (docs/method/bdd-event-sourcing.md): Given lists the
// events already in the stream, When sends exactly one command or request, Then names the
// response or page and the events that were appended. `given`/`when`/`then` carry the Event and
// Command names the catalogs give the phrases (empty when the catalogs have no such column);
// `warnings` lists every departure from the shape, in file order.
export interface ScenarioShape {
  given: string[]
  when: string[]
  then: string[]
  warnings: string[]
}

const PRIMARY = new Set<string>(['Given', 'When', 'Then'])

// An event says what happened, in the past tense; a name that opens with a CRUD verb in the
// imperative (`UpdateThread`, `SetPrice`) is a command or a table write, not an event. Abdullin,
// "Why Event Sourcing?": events named with Create, Insert, Update, Delete, Set, Change or Add mean
// the modeling went wrong. `UserAddedToAccount` stays fine — the verb is past tense.
const CRUD_COMMAND = /^(Create|Insert|Update|Delete|Set|Change|Add)(?=[A-Z]|$)/

function unique(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) === i)
}

// A step's effective keyword: And, But and * continue the previous primary keyword.
export function effectiveKeywords(steps: readonly StepView[], initial: StepKeyword | null = null): (StepKeyword | null)[] {
  let current: StepKeyword | null = initial
  return steps.map((step) => {
    if (PRIMARY.has(step.keyword)) current = step.keyword as StepKeyword
    return current
  })
}

export function scenarioShape(background: readonly StepView[], steps: readonly StepView[]): ScenarioShape {
  const all = [...background, ...steps]
  const keywords = effectiveKeywords(all)
  const warnings: string[] = []
  const at = (step: StepView): string => `line ${step.line}`
  const named = (keyword: StepKeyword): string[] => unique(all.flatMap((s, i) => (keywords[i] === keyword && s.event ? [s.event] : [])))

  const whens = all.filter((_, i) => keywords[i] === 'When')
  const thens = all.filter((_, i) => keywords[i] === 'Then')
  if (steps.length && keywords[background.length] === null) warnings.push(`starts with ${steps[0]!.keyword} (${at(steps[0]!)}) — the first step must be Given, When or Then`)
  if (whens.length === 0) warnings.push('no When step — a scenario sends exactly one command or request')
  if (whens.length > 1) warnings.push(`${whens.length} When steps (${whens.map(at).join(', ')}) — one command or request per scenario`)
  if (thens.length === 0) warnings.push('no Then step — nothing is expected of the command')

  let seenWhen = false
  let seenThen = false
  all.forEach((step, i) => {
    const keyword = keywords[i]
    if (keyword === 'When') seenWhen = true
    if (keyword === 'Then') seenThen = true
    if (keyword === 'Given' && seenWhen) warnings.push(`Given after When (${at(step)}) — every precondition is an event before the command`)
    if (keyword === 'When' && seenThen) warnings.push(`When after Then (${at(step)}) — a second command belongs in its own scenario`)
    if (keyword && step.catalogKeyword && step.catalogKeyword !== keyword) {
      warnings.push(`${at(step)}: "${step.text}" is a ${step.catalogKeyword} phrase in the catalog, used as ${keyword}`)
    }
    if ((keyword === 'Given' || keyword === 'Then') && step.event && CRUD_COMMAND.test(step.event)) {
      warnings.push(`${at(step)}: event ${step.event} is named like a command — an event says what happened, in the past tense`)
    }
  })

  return { given: named('Given'), when: named('When'), then: named('Then'), warnings }
}
