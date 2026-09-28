import { useState } from 'react'
import { api } from './api.ts'
import { AutoGrowTextarea } from './AutoGrowTextarea.tsx'
import { DocTab } from './DocTab.tsx'
import { useAction } from './feedback.tsx'
import type { TabProps } from './InitiativeScreen.tsx'

// Desk fixes item 2: the brief is read here and edited in place; Save writes brief.md and commits.
export function BriefTab({ id, view }: TabProps) {
  const act = useAction()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  if (draft === null) {
    return (
      <>
        <div className="toolbar">
          <button className="btn" onClick={() => setDraft(view.brief ?? '')}>Edit brief</button>
        </div>
        <DocTab title="brief.md" text={view.brief} />
      </>
    )
  }
  const save = (): void => {
    setSaving(true)
    void act(() => api.saveBrief(id, draft), 'Brief saved and committed')
      .then((ok) => { if (ok) setDraft(null) })
      .finally(() => setSaving(false))
  }
  return (
    <form className="panelform" onSubmit={(e) => { e.preventDefault(); save() }}>
      <AutoGrowTextarea className="briefedit" aria-label="Brief text" value={draft} maxLength={20_000} onChange={(e) => setDraft(e.target.value)} />
      <div className="row">
        <button type="button" className="btn" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
        <button type="submit" className="btn pri" disabled={saving || draft === (view.brief ?? '')}>Save brief</button>
      </div>
    </form>
  )
}
