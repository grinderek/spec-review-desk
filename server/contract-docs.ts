import { stringify } from 'yaml'
import type { ChangePackage, NativeContract, ParsedContractFile } from './change-package.ts'
import type { Fact } from './desk-dsl.ts'
import type { ExamplesView, StepView } from './gherkin.ts'
import { processReading, type ReadingPart } from './contract-reading.ts'

const heading = (text: string): string => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&')
function code(text: string, language = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text.trimEnd()}\n${fence}`
}
const yaml = (value: unknown): string => code(stringify(value, { lineWidth: 0 }), 'yaml')
const cell = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, '<br>')
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  if (!header.length) return ''
  const row = (values: readonly string[]): string => `| ${header.map((_, i) => cell(values[i] ?? '')).join(' | ')} |`
  return [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n')
}
function facts(title: string, values: readonly Fact[]): string {
  return [`**${title}**`, values.length ? yaml(values) : 'No events.'].join('\n\n')
}
function gherkinSteps(steps: readonly StepView[]): string {
  return steps.map(step => [
    `- **${heading(step.keyword)}** ${heading(step.text)}`,
    ...(step.table ? [table(step.table[0] ?? [], step.table.slice(1))] : []),
    ...(step.docString !== null ? [code(step.docString)] : []),
  ].filter(Boolean).join('\n\n')).join('\n\n')
}
function readingParts(parts: ReadingPart[]): string[] {
  return parts.map(part => typeof part === 'string' ? heading(part) : [
    heading(part.text),
    ...(part.table ? [table(part.table[0] ?? [], part.table.slice(1))] : []),
    ...(part.docString !== undefined ? [code(part.docString, part.mediaType?.replace(/[^\w+-]/g, '') ?? '')] : []),
  ].join('\n\n'))
}
function examples(examples: readonly ExamplesView[]): string {
  return examples.map(example => [`**Examples${example.name ? `: ${heading(example.name)}` : ''}**`, table(example.header, example.rows)].filter(Boolean).join('\n\n')).join('\n\n')
}
export function renderContract(contract: NativeContract): string {
  const sections = [`### ${heading(contract.title)}`, code(contract.key), `Contract hash: ${contract.hash}`, `Source hash: ${contract.sourceHash}`]
  const reading = contract.scenario.reading
  if (reading) {
    const variants = reading.variants ?? [{ label: '', reading }]
    sections.unshift(`### ${heading(reading.title)}`, ...variants.flatMap(({ label, reading: variant }) => [
      ...(label ? [`**Вариант: ${heading(label)}**`] : []),
      '**Дано**', ...readingParts(variant.given), '**Когда**', ...readingParts(Array.isArray(variant.when) ? variant.when : [variant.when]),
      '**Тогда**', ...readingParts(variant.then),
      ...(variant.observations?.length ? ['**В Desk**', ...variant.observations.map(line => `- ${heading(line)}`)] : []),
    ]), '**Технические подробности**')
  }
  if (contract.yaml) {
    const scenario = contract.yaml
    if (scenario.cases) {
      const headers = [...new Set(scenario.cases.flatMap(row => Object.keys(row)))]
      sections.push('**Cases**', table(headers, scenario.cases.map(row => headers.map(header => JSON.stringify(row[header]) ?? ''))))
    }
    sections.push(facts('Given', scenario.given), '**When**', yaml(scenario.when))
    if (scenario.then.bind) sections.push('**Response bindings**', yaml(scenario.then.bind))
    sections.push(facts(`Then - ${scenario.then.stream ?? 'review'} events`, scenario.then.events), '**Response**', yaml(scenario.then.response))
    if (scenario.then.reads?.length) {
      sections.push('**Subsequent public reads**')
      for (const read of scenario.then.reads) sections.push(yaml(read))
    }
  } else {
    sections.push(gherkinSteps(contract.scenario.steps))
    if (contract.scenario.examples.length) sections.push(examples(contract.scenario.examples))
  }
  return sections.filter(Boolean).join('\n\n')
}

// Generated from executable data. No second editable title list or assertion source is created.
export function renderContractDocumentation(files: readonly ParsedContractFile[]): string {
  return files.map(file => [
    `## ${heading(processReading(file.file)?.title ?? file.feature.name)}`,
    code(file.file),
    ...(file.feature.description ? [file.feature.description] : []),
    ...(file.feature.background.length ? ['**Background**', gherkinSteps(file.feature.background)] : []),
    ...file.contracts.map(renderContract),
  ].join('\n\n')).join('\n\n') + '\n'
}
export function renderChangeDocumentation(change: Pick<ChangePackage, 'metadata' | 'files'>): string {
  const title = change.metadata?.title ?? 'Executable contracts'
  return `# ${heading(title)}\n\n${renderContractDocumentation(change.files)}`
}
