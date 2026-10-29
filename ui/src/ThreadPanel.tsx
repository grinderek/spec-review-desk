import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
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

function titleOf(thread: Thread, view?: ChangeView): string {
  if (thread.anchor === 'scenario') return view?.features.flatMap(f => f.scenarios).find(s => s.key === thread.ref)?.title ?? thread.ref.split('::').slice(1).join('::')
  if (thread.anchor === 'phrase') return thread.ref.replace(/#extension$/, ' (meaning extension)')
  if (thread.anchor === 'apply') return `Apply run ${thread.ref}`
  return 'The whole change'
}

export function ThreadPanel({ id, target, onTarget, onClose }: { id: ChangeId; target: PanelTarget | null; onTarget: (t: PanelTarget) => void; onClose: (threadId: string) => void }) {
  const act = useAction()
  const client = useQueryClient()
  const change = useQuery({ queryKey: ['change', id.wt, id.name], queryFn: () => api.change(id) })
  const [text, setText] = useState('')
  const [live, setLive] = useState('')
  const [phase, setPhase] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const view = change.data
  const archived = view?.archived ?? false
  const thread = target?.kind === 'thread' ? view?.review.threads.find((t) => t.id === target.id) ?? null : null
  const messages = useRef<HTMLDivElement>(null)
  useEffect(() => {
    messages.current?.scrollTo({ top: messages.current.scrollHeight })
  }, [thread?.id, thread?.messages.length])
  const applyRunning = view?.review.apply_runs.some((r) => r.outcome === 'running' || r.outcome === 'uncertain') ?? false
  const agentBusy = view?.review.executions.some(run => run.request.role === 'reviewer' && ['queued', 'running', 'uncertain'].includes(run.outcome)) ?? false
  const question = view?.review.executions.findLast(run => run.request.role === 'reviewer' && run.request.threadId === thread?.id)
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
    if (!body || !target) return
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

  const title = thread ? titleOf(thread, view) : target?.kind === 'new' ? target.title : ''
  const others = view?.review.threads.filter((t) => t.status !== 'resolved') ?? []
  const closed = view?.review.threads.filter(t => t.status === 'resolved') ?? []
  const latestPatch = thread?.messages.findLastIndex(m => Boolean(m.patch)) ?? -1
  const resolve = async () => {
    if (!thread || resolving) return
    setResolving(true)
    try {
      await act(async () => {
        await api.resolveThread(id, thread.id)
        await client.cancelQueries({ queryKey: ['change', id.wt, id.name] })
        client.setQueryData<ChangeView>(['change', id.wt, id.name], current => current ? {
          ...current, review: { ...current.review, threads: current.review.threads.map(t => t.id === thread.id ? { ...t, status: 'resolved' } : t) },
        } : current)
        onClose(thread.id)
      }, 'Thread resolved')
    } finally { setResolving(false) }
  }

  return (
    <>
      <div className="thead">
        <div className="k">{thread ? `Thread · ${thread.anchor}` : target?.kind === 'new' ? 'New thread' : 'Открытые обсуждения'}</div>
        <div className="t">{title}</div>
        {thread ? <div className="hash">{thread.status}{view?.review.agent_session ? ` · agent session ${view.review.agent_session.slice(0, 8)}…` : ''}</div> : null}
      </div>
      {others.length ? (
        <nav className="tlist" aria-label="Открытые обсуждения">
          {others.map((t) => (
            <button key={t.id} className="chip" title={t.messages.find(m => m.role === 'owner')?.text} aria-pressed={t.id === thread?.id} onClick={() => onTarget({ kind: 'thread', id: t.id })}>
              {titleOf(t, view)} · {t.status}
            </button>
          ))}
        </nav>
      ) : null}
      {closed.length ? <details className="thread-history">
        <summary>Закрытые обсуждения ({closed.length})</summary>
        <div className="tlist">
          {closed.map(t => <button key={t.id} className="chip" onClick={() => onTarget({ kind: 'thread', id: t.id })}>{titleOf(t, view)}</button>)}
        </div>
      </details> : null}
      <div className="msgs" ref={messages}>
        {thread ? null : (
          <p className="empty">{target?.kind === 'new' ? "The change's agent session answers from the files and may attach a patch; nothing changes until you apply it." : 'Select a scenario and ask a question, or open a thread.'}</p>
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
            {m.patch ? index === latestPatch ? <PatchCard id={id} threadId={thread.id} index={index} message={m} disabled={applyRunning} agentBusy={agentBusy} archived={archived} /> : (
              <details className="patch-history"><summary>Предыдущий патч · {m.patch.state}</summary>
                <PatchCard id={id} threadId={thread.id} index={index} message={m} disabled={applyRunning} agentBusy={agentBusy} archived={archived} />
              </details>
            ) : null}
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
        {question?.outcome === 'uncertain' ? <div className="fail">
          <p>The question result is uncertain. {question.reason}</p>
          <button className="btn" onClick={() => void act(() => api.resumeQuestion(id, question.request.id), 'Question resumed explicitly')}>Resume question</button>
        </div> : null}
        {question?.outcome === 'running' ? <button className="btn bad" onClick={() => void act(() => api.stopQuestion(id, question.request.id), 'Stopping question')}>Stop question</button> : null}
      </div>
      {archived || !target || thread?.status === 'resolved' ? null : (
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
            {thread ? (
              <button type="button" className="btn" disabled={resolving} onClick={() => void resolve()}>{resolving ? 'Resolving...' : 'Resolve'}</button>
            ) : null}
            <button className="btn pri" type="submit">Send</button>
          </div>
        </form>
      )}
    </>
  )
}
