import type { ContractReading as Reading, ReadingPart } from '../../server/contract-reading.ts'
import type { ScenarioView } from '../../server/gherkin.ts'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Markdown, TableFrame } from './Markdown.tsx'

function ReadingParts({ parts }: { parts: ReadingPart[] }) {
  return parts.map((part, i) => {
    if (typeof part === 'string') return <Markdown key={i} text={part} />
    const header = part.table?.[0]
    return <div className="reading-step" key={i}>
      <p className="reading-text">{part.text}</p>
      {header ? <TableFrame label={part.text}><table className="reading-table">
        <thead><tr>{header.map((cell, c) => <th key={c} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{part.table!.slice(1).map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
      </table></TableFrame> : null}
      {part.docString !== undefined ? /^(?:text\/)?(?:markdown|md)$/i.test(part.mediaType ?? '')
        ? <Markdown text={part.docString} />
        : <pre className="doc"><code>{part.docString}</code></pre> : null}
    </div>
  })
}

export function ContractReading({ reading }: { reading: Reading }) {
  const [variant, setVariant] = useState(0)
  const selected = reading.variants?.[variant]?.reading ?? reading.variants?.[0]?.reading ?? reading
  return <>
    {reading.variants?.length ? <label className="reading-variant">Вариант правила
      <select value={Math.min(variant, reading.variants.length - 1)} onChange={e => setVariant(Number(e.target.value))}>
        {reading.variants.map((v, i) => <option key={i} value={i}>{v.label}</option>)}
      </select>
      <span className="rules-meta">Вариантов: {reading.variants.length}. Ниже показаны условия и ожидания выбранного варианта.</span>
    </label> : null}
    <dl className="contract-reading">
      <div><dt>Дано</dt><dd>{selected.given.length ? <ReadingParts parts={selected.given} /> : <p>Предыдущих событий нет.</p>}</dd></div>
      <div><dt>Когда</dt><dd><ReadingParts parts={Array.isArray(selected.when) ? selected.when : [selected.when]} /></dd></div>
      <div><dt>Тогда</dt><dd><ReadingParts parts={selected.then} /></dd></div>
      {selected.observations?.length ? <div><dt>В Desk</dt><dd><ReadingParts parts={selected.observations} /></dd></div> : null}
    </dl>
  </>
}

export function ContractDetails({ scenario, children }: { scenario: ScenarioView; children?: ReactNode }) {
  return <details className="contract-details">
    <summary>Подробности: исполняемый контракт</summary>
    <p className="hash">{scenario.file} · {scenario.id}<br />{scenario.hash}</p>
    {children}
    <pre className="doc" data-desk-contract>{scenario.source}</pre>
  </details>
}
