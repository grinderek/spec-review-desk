import { useId, useState } from 'react'
import type { ChangeView } from '../../server/change-view.ts'
import { api, type ChangeId } from './api.ts'
import { optionIds, scenarioTitle } from './decision-view.ts'
import { useAction } from './feedback.tsx'

interface Draft { label: string; consequence: string }

export function NewDecisionForm({ id, view, onClose }: { id: ChangeId; view: ChangeView; onClose: () => void }) {
  const act = useAction()
  const uid = useId()
  const [question, setQuestion] = useState('')
  const [scope, setScope] = useState('')
  const [blocking, setBlocking] = useState(true)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const keys = view.features.flatMap((f) => f.scenarios.map((s) => s.key))
  const filled = drafts.filter((o) => o.label.trim())
  const valid = question.trim() !== '' && (filled.length === 0 || (filled.length >= 2 && filled.every((o) => o.consequence.trim())))
  const update = (index: number, change: Partial<Draft>) =>
    setDrafts((current) => current.map((o, i) => (i === index ? { ...o, ...change } : o)))
  const submit = () => {
    const ids = optionIds(filled.map((o) => o.label))
    return act(async () => {
      await api.addDecision(id, {
        question: question.trim(),
        scope: scope ? { kind: 'scenario', key: scope } : { kind: 'change' },
        blocking,
        options: filled.map((o, i) => ({ id: ids[i]!, label: o.label.trim(), consequence: o.consequence.trim() })),
      })
      onClose()
    }, 'Decision opened')
  }
  return (
    <form className="dnew" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label htmlFor={`${uid}-question`}>Decision question</label>
      <textarea id={`${uid}-question`} value={question} maxLength={400} onChange={(e) => setQuestion(e.target.value)} />
      <label htmlFor={`${uid}-scope`}>Scope</label>
      <select id={`${uid}-scope`} value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="">Whole change</option>
        {keys.map((k) => <option key={k} value={k}>{scenarioTitle(k)}</option>)}
      </select>
      <label className="check">
        <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} /> Blocking — the change is not ready while it is open
      </label>
      {drafts.map((o, i) => (
        <div className="optrow" key={i}>
          <input aria-label={`Option ${i + 1}`} placeholder="Option" value={o.label} maxLength={120} onChange={(e) => update(i, { label: e.target.value })} />
          <input aria-label={`Consequence ${i + 1}`} placeholder="Consequence" value={o.consequence} maxLength={400} onChange={(e) => update(i, { consequence: e.target.value })} />
          <button type="button" className="btn" aria-label={`Remove option ${i + 1}`} onClick={() => setDrafts((current) => current.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row">
        <span className="hash">No options, or 2 to 4 — a decision without options is answered with a note.</span>
        <button type="button" className="btn" disabled={drafts.length >= 4} onClick={() => setDrafts((current) => [...current, { label: '', consequence: '' }])}>+ Option</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn pri" disabled={!valid}>Save decision</button>
      </div>
    </form>
  )
}
