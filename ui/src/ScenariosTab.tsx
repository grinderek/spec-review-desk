import { useEffect, useState } from 'react'
import type { ChangeView, ScenarioWithStatus } from '../../server/change-view.ts'
import type { CorpusReport } from '../../server/corpus.ts'
import type { RunnerState } from '../../server/runner.ts'
import type { ChangeId } from './api.ts'
import type { PanelTarget } from './App.tsx'
import { useAction } from './feedback.tsx'
import { api } from './api.ts'
import { scenarioOpen } from './decision-view.ts'
import { corpusKey, cssId, useKeys } from './keys.ts'
import { ScenarioCard } from './ScenarioCard.tsx'
import { StepLines } from './StepLines.tsx'

const FILTERS = [['all', 'All'], ['pending', 'Pending'], ['changes_requested', 'Changes requested'], ['red', 'Red']] as const
type Filter = (typeof FILTERS)[number][0]

export interface ScenariosTabProps {
  id: ChangeId
  view: ChangeView
  corpus: CorpusReport | undefined
  runner: RunnerState | null
  setPanel: (target: PanelTarget) => void
  focusKey: string | null
  onDecision: (decisionId: string) => void
}

export function ScenariosTab({ id, view, corpus, runner, setPanel, focusKey, onDecision }: ScenariosTabProps) {
  const act = useAction()
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const runOf = (s: ScenarioWithStatus) => runner?.result?.scenarios[corpusKey(s.file, s.title)]
  const shown = (s: ScenarioWithStatus) =>
    filter === 'all' || (filter === 'red' ? runOf(s)?.status === 'failed' : s.effective.status === filter)
  const visible = view.features.flatMap((f) => f.scenarios.filter(shown))
  const threadFor = (key: string) => {
    const threads = view.review.threads.filter((t) => t.anchor === 'scenario' && t.ref === key)
    return threads.find((t) => t.status !== 'resolved') ?? threads.at(-1)
  }
  const ask = (s: ScenarioWithStatus) => {
    const thread = threadFor(s.key)
    setPanel(thread ? { kind: 'thread', id: thread.id } : { kind: 'new', anchor: 'scenario', ref: s.key, title: s.title })
  }
  const toggle = (key: string) => {
    setCursor(key)
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const focus = (key: string) => {
    setCursor(key)
    setOpen((current) => new Set(current).add(key))
    window.requestAnimationFrame(() => document.getElementById(`scn-${cssId(key)}`)?.scrollIntoView({ block: 'center' }))
  }
  useEffect(() => {
    if (focusKey) focus(focusKey)
  }, [focusKey])
  const move = (delta: number) => {
    const index = visible.findIndex((s) => s.key === cursor)
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))]
    if (next) focus(next.key)
  }
  const current = visible.find((s) => s.key === cursor)
  useKeys({
    j: () => move(1),
    k: () => move(-1),
    a: () => {
      if (current && !view.archived) void act(() => api.approveScenario(id, current.key), 'Scenario approved')
    },
    q: () => {
      if (current && !view.archived) ask(current)
    },
  })

  return (
    <>
      <div className="toolbar">
        {FILTERS.map(([key, label]) => (
          <button key={key} className="chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
        ))}
        <span className="legend">
          <span><span className="ph catalog">phrase</span> in STEPS.md</span>
          <span><span className="ph new">phrase</span> new</span>
          <span><span className="ph uncatalogued">phrase</span> uncatalogued</span>
          <span>keys: j / k · a approve · q ask</span>
        </span>
      </div>
      {view.features.map((feature) => (
        <section key={feature.file} className="feature">
          <div className="fhead">
            {feature.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            <h3>Feature: {feature.name}</h3>
            <span className="file">{feature.file}</span>
          </div>
          {feature.preamble.map((note, i) => <p key={i} className="note">{note}</p>)}
          {feature.background.length ? (
            <div className="background code">
              <div className="kwline">Background:</div>
              <StepLines steps={feature.background} />
            </div>
          ) : null}
          {feature.scenarios.filter(shown).map((s) => (
            <ScenarioCard
              key={s.key}
              id={id}
              scenario={s}
              run={runOf(s)}
              corpus={corpus?.states[s.key]}
              thread={threadFor(s.key)}
              open={open.has(s.key)}
              selected={cursor === s.key}
              readOnly={view.archived}
              onToggle={() => toggle(s.key)}
              onAsk={() => ask(s)}
              decisions={scenarioOpen(view.decisions, s.key)}
              onDecision={onDecision}
            />
          ))}
        </section>
      ))}
    </>
  )
}
