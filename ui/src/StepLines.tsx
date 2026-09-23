import { Fragment } from 'react'
import type { StepView } from '../../server/gherkin.ts'
import type { DiffLine } from './diff.ts'

const TITLES = {
  catalog: 'In features/STEPS.md — an approved phrase',
  new: 'In NEW_STEPS.md — awaiting your approval',
  uncatalogued: 'In neither catalog — the change must add it to NEW_STEPS.md',
} as const

function withStrings(text: string) {
  return text.split(/("[^"]*")/).map((part, i) => (part.startsWith('"') && part.endsWith('"') && part.length > 1 ? <span key={i} className="str">{part}</span> : part))
}

export function DataTable({ rows }: { rows: string[][] }) {
  return (
    <table className="dt">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

export function StepLines({ steps }: { steps: StepView[] }) {
  return (
    <>
      {steps.map((step) => (
        <Fragment key={step.line}>
          <div className="step">
            <span className="kw">{step.keyword}</span>
            <span className="tx">
              <span className={`ph ${step.kind}`} title={step.phrase ? `${TITLES[step.kind]}: ${step.phrase}` : TITLES[step.kind]}>{withStrings(step.text)}</span>
              {step.extended ? <span className="pill p-ext" title="This change extends the phrase's meaning (NEW_STEPS.md)"> extended meaning</span> : null}
            </span>
          </div>
          {step.table ? <DataTable rows={step.table} /> : null}
          {step.docString !== null ? <pre className="doc">{step.docString}</pre> : null}
        </Fragment>
      ))}
    </>
  )
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diffview">
      {lines.map((line, i) => (
        <div key={i} className={line.kind}>{line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text || ' '}</div>
      ))}
    </div>
  )
}
