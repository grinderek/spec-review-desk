import { useState } from 'react'
import { api } from './api.ts'
import { AutoGrowTextarea } from './AutoGrowTextarea.tsx'
import { DocTab } from './DocTab.tsx'
import { useAction, useToast } from './feedback.tsx'
import type { TabProps } from './InitiativeScreen.tsx'

// Desk fixes item 2: the brief is read here and edited in place; Save writes brief.md and commits.
// The editor is uncontrolled and read from the form at submit (review fix 3): a tool that sets the
// value directly — the pilot's automation does for 100+ characters — is saved like typing is.
// Save is never gated on the text: an unchanged brief is a harmless no-op on the server.
export function BriefTab({ id, view }: TabProps) {
  const act = useAction()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  if (!editing) {
    return (
      <>
        <div className="toolbar">
          <button className="btn" onClick={() => setEditing(true)}>Edit brief</button>
        </div>
        <DocTab title="brief.md" text={view.brief} />
      </>
    )
  }
  const save = (form: HTMLFormElement): void => {
    const brief = String(new FormData(form).get('brief') ?? '')
    let committed = false
    setSaving(true)
    void act(async () => { committed = (await api.saveBrief(id, brief)).commit !== null })
      .then((ok) => {
        if (!ok) return
        toast(committed ? 'Brief saved and committed' : 'No change to the brief', 'ok')
        setEditing(false)
      })
      .finally(() => setSaving(false))
  }
  return (
    <form className="panelform" onSubmit={(e) => { e.preventDefault(); save(e.currentTarget) }}>
      <AutoGrowTextarea className="briefedit" name="brief" aria-label="Brief text" defaultValue={view.brief ?? ''} maxLength={20_000} />
      <div className="row">
        <button type="button" className="btn" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        <button type="submit" className="btn pri" disabled={saving}>Save brief</button>
      </div>
    </form>
  )
}
