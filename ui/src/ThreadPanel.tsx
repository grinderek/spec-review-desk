import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import type { ChangeView } from '../../server/change-view.ts'
import type { Thread } from '../../server/review-store.ts'
import { api, type ChangeId, changeDecisions } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { DecisionCard } from './DecisionCard.tsx'
import { resumeState } from './decision-view.ts'
import { useEventStream } from './events.ts'
import { useAction } from './feedback.tsx'
import { stripDiff } from './keys.ts'
import { Markdown } from './Markdown.tsx'
import { PatchCard } from './PatchCard.tsx'

function ApplyResume({ id, view, runId }: { id: ChangeId; view: ChangeView; runId: string }) {
  const act = useAction()
  const run = view.review.apply_runs.find((r) => r.id === runId)
  const state = resumeState(view.decisions, runId)
  if (!run || run.outcome !== 'needs_owner' || view.archived || state.blocking === 0) return null
  const running = view.review.apply_runs.some((r) => r.outcome === 'running')
  return (
    <div className="resume">
      <span className="hash">{state.settled} of {state.blocking} blocking decision{state.blocking > 1 ? 's' : ''} recorded or dismissed</span>
      <button className="btn pri" disabled={!state.ready || running} onClick={() => void act(() => api.resumeApply(id, runId), 'Apply resumed with your decisions')}>
        Resume with decisions
      </button>
    </div>
  )
}

function titleOf(thread: Thread): string {
  if (thread.anchor === 'scenario') return thread.ref.split('::').slice(1).join('::')
  if (thread.anchor === 'phrase') return thread.ref.replace(/#extension$/, ' (meaning extension)')
  if (thread.anchor === 'apply') return `Apply run ${thread.ref}`
  return 'The whole change'
}

export function ThreadPanel({ id, target, onTarget }: { id: ChangeId; target: PanelTarget; onTarget: (t: PanelTarget) => void }) {
  const act = useAction()
  const change = useQuery({ queryKey: ['change', id.wt, id.name], queryFn: () => api.change(id) })
  const [text, setText] = useState('')
  const [live, setLive] = useState('')
  const [phase, setPhase] = useState<string | null>(null)
  const view = change.data
  const archived = view?.archived ?? false
  const thread = target.kind === 'thread' ? view?.review.threads.find((t) => t.id === target.id) ?? null : null
  const applyRunning = view?.review.apply_runs.some((r) => r.outcome === 'running') ?? false
  const scenarioKeys = view?.features.flatMap((f) => f.scenarios.map((s) => s.key)) ?? []

  useEventStream(thread ? `thread:${thread.id}` : null, (message) => {
    const data = message.data as { type?: string; text?: string } | null
    if (!data?.type) return
    if (data.type === 'delta') setLive((current) => current + (data.text ?? ''))
    else if (data.type === 'reset') setLive('')
    else if (data.type === 'done') {
      setLive('')
      setPhase(null)
    } else setPhase(data.type)
  })

  const send = async (e: FormEvent | KeyboardEvent) => {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    const ok = await act(async () => {
      if (target.kind === 'new') {
        const created = await api.newThread(id, { anchor: target.anchor, ref: target.ref, text: body })
        onTarget({ kind: 'thread', id: created.id })
      } else {
        await api.reply(id, target.id, body)
      }
    })
    if (ok) {
      setText('')
      setLive('')
      setPhase('queued')
    }
  }

  const title = thread ? titleOf(thread) : target.kind === 'new' ? target.title : ''
  const others = view?.review.threads.filter((t) => t.status !== 'resolved') ?? []

  return (
    <>
      <div className="thead">
        <div className="k">{thread ? `Thread · ${thread.anchor}` : 'New thread'}</div>
        <div className="t">{title}</div>
        {thread ? <div className="hash">{thread.status}{view?.review.agent_session ? ` · agent session ${view.review.agent_session.slice(0, 8)}…` : ''}</div> : null}
      </div>
      {others.some((t) => t.id !== thread?.id) ? (
        <div className="tlist">
          {others.map((t) => (
            <button key={t.id} className="chip" aria-pressed={t.id === thread?.id} onClick={() => onTarget({ kind: 'thread', id: t.id })}>
              {t.anchor} · {t.status}
            </button>
          ))}
        </div>
      ) : null}
      <div className="msgs">
        {thread ? null : (
          <p className="empty">The change's agent session answers from the files and may attach a patch; nothing changes until you apply it.</p>
        )}
        {thread?.messages.map((m, index) => (
          <div key={index} className={`msg ${m.role}`}>
            <div className="who"><b>{m.role === 'owner' ? 'you' : 'agent'}</b>{new Date(m.at).toLocaleTimeString()}</div>
            {m.note ? <div className="mnote">{m.note}</div> : null}
            <div className="body">{m.role === 'agent' ? <Markdown text={stripDiff(m.text) || '(patch only)'} /> : m.text}</div>
            {m.invalid ? (
              <div className="invalid">
                <div className="fail">{m.invalid.issues.map((issue, i) => <div key={i}>{issue}</div>)}</div>
                <details>
                  <summary>Raw reply</summary>
                  <pre className="doc">{m.invalid.raw}</pre>
                </details>
              </div>
            ) : null}
            {m.patch ? <PatchCard id={id} threadId={thread.id} index={index} message={m} disabled={applyRunning} archived={archived} /> : null}
            {(m.decision_ids ?? []).map((decisionId) => {
              const decision = view?.decisions.find((d) => d.id === decisionId)
              return decision ? (
                <DecisionCard key={decisionId} client={changeDecisions(id)} decision={decision} archived={archived} scenarioKeys={scenarioKeys} onThread={(t) => onTarget({ kind: 'thread', id: t })} />
              ) : null
            })}
          </div>
        ))}
        {live ? <div className="msg"><div className="who"><b>agent</b>streaming</div><div className="body"><Markdown text={stripDiff(live)} /></div></div> : null}
        {!live && phase ? <div className="typing">{phase === 'queued' ? 'Queued — waiting for the agent…' : 'The agent is reading the change…'}</div> : null}
        {thread?.anchor === 'apply' && view ? <ApplyResume id={id} view={view} runId={thread.ref} /> : null}
      </div>
      {archived ? null : (
        <form className="compose" onSubmit={(e) => void send(e)}>
          <label htmlFor="thread-input">{thread ? 'Reply' : 'Question'}</label>
          <textarea
            id="thread-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e)
            }}
            placeholder="Ask about this — the agent answers from the change files"
          />
          <div className="row">
            <span className="hash">Ctrl/⌘ + Enter to send</span>
            {thread && thread.status !== 'resolved' ? (
              <button type="button" className="btn" onClick={() => void act(() => api.resolveThread(id, thread.id), 'Thread resolved')}>Resolve</button>
            ) : null}
            <button className="btn pri" type="submit">Send</button>
          </div>
        </form>
      )}
    </>
  )
}
