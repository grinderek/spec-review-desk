import { useId, useState } from 'react'
import { api, type InitiativeId, type InitiativesResponse } from './api.ts'
import { useAction } from './feedback.tsx'
import { createPreview } from './initiative-view.ts'

const NAME = /^[a-z0-9][a-z0-9-]{1,40}$/

// Spec B §4.1/§8: the New feature dialog with a live preview of the git commands Create runs.
export function NewFeature({ choices, onCreated }: { choices: InitiativesResponse | undefined; onCreated: (id: InitiativeId) => void }) {
  const act = useAction()
  const uid = useId()
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [where, setWhere] = useState<'new' | 'existing'>('new')
  const [base, setBase] = useState<string | null>(null)
  const [worktree, setWorktree] = useState('')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [fromRepo, setFromRepo] = useState('')
  if (!choices) return <p className="empty">Loading repositories…</p>
  const repoChoice = choices.repos.find((r) => r.name === repo) ?? choices.repos[0]
  const baseValue = base ?? choices.defaultBase
  const wt = repoChoice?.worktrees.find((w) => w.id === worktree) ?? null
  const preview = createPreview({ name: NAME.test(name) ? name : '', repoPath: repoChoice?.path ?? '', where, base: baseValue, worktreePath: wt?.path ?? null })
  const valid = NAME.test(name) && title.trim() !== '' && repoChoice !== undefined && (where === 'new' ? baseValue.trim() !== '' : wt !== null)
  const create = () =>
    act(async () => {
      const form = new FormData()
      form.set('name', name)
      form.set('repo', repoChoice!.name)
      form.set('where', where)
      form.set('base', baseValue)
      form.set('worktreeId', wt?.id ?? '')
      form.set('title', title.trim())
      form.set('brief', brief)
      form.set('fromRepo', fromRepo)
      for (const f of files) form.append('files', f)
      const created = await api.createInitiative(form)
      onCreated({ wt: created.worktreeId, name: created.name })
    }, `Initiative ${name} created`)
  return (
    <form className="head newfeature" onSubmit={(e) => { e.preventDefault(); void create() }}>
      <h1>New feature</h1>
      <label htmlFor={`${uid}-name`}>Name</label>
      <input id={`${uid}-name`} value={name} placeholder="health-score" onChange={(e) => setName(e.target.value.trim())} />
      {name && !NAME.test(name) ? <small className="errtext">a-z, 0-9 and -, 2 to 41 characters</small> : null}
      <label htmlFor={`${uid}-repo`}>Repository</label>
      <select id={`${uid}-repo`} value={repoChoice?.name ?? ''} onChange={(e) => { setRepo(e.target.value); setWorktree('') }}>
        {choices.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
      </select>
      <fieldset className="where">
        <legend>Where</legend>
        <label><input type="radio" checked={where === 'new'} onChange={() => setWhere('new')} /> New worktree from</label>
        <input aria-label="Base branch" value={baseValue} disabled={where !== 'new'} onChange={(e) => setBase(e.target.value)} />
        <label><input type="radio" checked={where === 'existing'} onChange={() => setWhere('existing')} /> Existing worktree</label>
        <select aria-label="Existing worktree" value={worktree} disabled={where !== 'existing'} onChange={(e) => setWorktree(e.target.value)}>
          <option value="">(pick one)</option>
          {repoChoice?.worktrees.map((w) => <option key={w.id} value={w.id}>{w.branch ?? 'detached'} · {w.path}</option>)}
        </select>
      </fieldset>
      <label htmlFor={`${uid}-title`}>Title</label>
      <input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${uid}-brief`}>Brief</label>
      <textarea id={`${uid}-brief`} value={brief} placeholder="What, why, out of scope (Markdown)" onChange={(e) => setBrief(e.target.value)} />
      <label htmlFor={`${uid}-files`}>Inputs to upload</label>
      <input id={`${uid}-files`} type="file" multiple accept=".pdf,.md,.txt,.yaml,.yml,.json,.png,.jpg,.jpeg" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      <label htmlFor={`${uid}-from`}>Add from repo (one path per line, relative to the hub)</label>
      <textarea id={`${uid}-from`} value={fromRepo} placeholder="api/doc/health_score_client_contract.md" onChange={(e) => setFromRepo(e.target.value)} />
      <div className="preview" aria-label="Create will run">
        <div className="k">Create will run</div>
        {preview.length ? preview.map((line) => <code key={line}>{line}</code>) : <span className="hash">Name the feature to see the commands.</span>}
      </div>
      <div className="row">
        <button type="submit" className="btn pri" disabled={!valid}>Create</button>
      </div>
    </form>
  )
}
