import { type ReactNode, useState } from 'react'
import type { ChangeView } from '../../server/change-view.ts'
import type { CorpusReport } from '../../server/corpus.ts'
import type { RunnerState } from '../../server/runner.ts'
import { api, type Capabilities, type ChangeId, type Section } from './api.ts'
import { useAction } from './feedback.tsx'

function RunnerStat({ id, runner, docker }: { id: ChangeId; runner: RunnerState | null; docker: boolean }) {
  const act = useAction()
  let value: ReactNode
  if (!runner) value = <span className="pill">no runner profile</span>
  else if (runner.running) value = <span className="pill p-thread">running…</span>
  else if (runner.up === false) value = (
    <>
      <span className="pill r-failed">runner off</span>
      <button className="btn" disabled={!docker} onClick={() => void act(() => api.startRunner(id.wt), 'Starting the container…')}>Start</button>
    </>
  )
  else if (runner.result) value = (
    <>
      <span className={`dot ${runner.result.totals.failed ? 'bad' : 'ok'}`} />
      {runner.result.totals.passed} green · {runner.result.totals.failed} red{runner.result.totals.other ? ` · ${runner.result.totals.other} other` : ''}
      <button className="btn" disabled={!docker} onClick={() => void act(() => api.runCorpus(id.wt))}>Run now</button>
    </>
  )
  else value = <button className="btn" disabled={!docker} onClick={() => void act(() => api.runCorpus(id.wt))}>Run now</button>
  return (
    <div>
      <div className="k">Corpus run{runner?.lastRunAt ? ` · ${new Date(runner.lastRunAt).toLocaleTimeString()}` : ''}</div>
      <div className="v">{value}</div>
      {runner?.error ? <div className="hash">{runner.error}</div> : null}
    </div>
  )
}

function OrphanRow({ id, view, section, entryKey }: { id: ChangeId; view: ChangeView; section: Section; entryKey: string }) {
  const act = useAction()
  const targets = section === 'scenarios' ? view.features.flatMap((f) => f.scenarios.map((s) => s.key)) : view.phrases.map((p) => p.key)
  const [to, setTo] = useState(targets[0] ?? '')
  return (
    <div>
      Orphaned review entry <code>{entryKey}</code>
      {view.archived ? null : (
        <>
          {' '}
          <select aria-label="Re-attach to" value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>{' '}
          <button className="btn" disabled={!to} onClick={() => void act(() => api.reattachOrphan(id, section, entryKey, to), 'Re-attached')}>Re-attach</button>{' '}
          <button className="btn bad" onClick={() => void act(() => api.dropOrphan(id, section, entryKey), 'Dropped')}>Drop</button>
        </>
      )}
    </div>
  )
}

export interface ChangeHeaderProps {
  id: ChangeId
  view: ChangeView
  corpus: CorpusReport | undefined
  runner: RunnerState | null
  capabilities: Capabilities | undefined
}

export function ChangeHeader({ id, view, corpus, runner, capabilities }: ChangeHeaderProps) {
  const act = useAction()
  const scenarios = view.features.flatMap((f) => f.scenarios)
  const approved = scenarios.filter((s) => s.effective.status === 'approved').length
  const phrasesApproved = view.phrases.filter((p) => p.effective.status === 'approved').length
  const openThreads = view.review.threads.filter((t) => t.status !== 'resolved' && t.anchor !== 'apply').length
  const running = view.review.apply_runs.some((r) => r.outcome === 'running')
  const drift = corpus?.drift ?? []
  const recorded = view.review.approved_at !== null
  const jk = view.joinKey
  return (
    <div className="head">
      <div className="crumbs">{view.repo} · {view.branch ?? 'detached'} · {view.relDir}</div>
      <h1>{view.name}{view.archived ? <span className="pill">archived</span> : null}</h1>
      <div className="gate">
        <div><div className="k">Scenarios approved</div><div className="v">{approved} / {scenarios.length}</div></div>
        <div><div className="k">New phrases approved</div><div className="v">{phrasesApproved} / {view.phrases.length}</div></div>
        <div><div className="k">Open threads</div><div className="v">{openThreads}</div></div>
        <RunnerStat id={id} runner={runner} docker={capabilities?.docker ?? false} />
      </div>
      <div className="gatebar">
        <span className={`ready${view.readiness.ready ? ' on' : ''}`}>{recorded ? `approved ${view.review.approved_at!.slice(0, 10)}` : 'ready for /opsx:apply'}</span>
        {view.readiness.ready ? null : <small>Blocked: {view.readiness.reasons.join(' · ')}</small>}
        {view.readiness.ready && !view.archived && (!recorded || view.uncommittedReview) ? (
          <button className="btn ok" onClick={() => void act(() => api.recordApproval(id), 'Approval recorded and committed')}>Record approval</button>
        ) : null}
        {recorded && !view.archived ? (
          <button className="btn pri" disabled={!view.readiness.ready || running || !capabilities?.claude} onClick={() => void act(() => api.startApply(id), 'Apply started')}>Apply</button>
        ) : null}
        {running && !view.archived ? <button className="btn bad" onClick={() => void act(() => api.stopApply(id), 'Stopping the Apply run…')}>Stop</button> : null}
        {drift.length && !view.archived ? (
          <button className="btn" disabled={running || !capabilities?.claude} onClick={() => void act(() => api.reapply(id), 'Re-apply started')}>Re-apply {drift.length} changed scenario{drift.length > 1 ? 's' : ''}</button>
        ) : null}
      </div>
      <div className="warnings">
        {view.errors.map((e) => <div key={e.file} className="err">{e.message}</div>)}
        {view.reviewErrors ? <div className="err">review.yaml is invalid and will not be written: {view.reviewErrors.join('; ')}</div> : null}
        {jk.ok ? null : (
          <div>
            Join key: {jk.missingInFeatures.length ? `spec.md titles without a scenario: ${jk.missingInFeatures.join(', ')}. ` : ''}
            {jk.missingInSpecs.length ? `scenarios without a spec.md line: ${jk.missingInSpecs.join(', ')}. ` : ''}
            {jk.duplicateTitles.length ? `duplicate titles: ${jk.duplicateTitles.join(', ')}.` : ''}
          </div>
        )}
        {view.orphans.scenarios.map((k) => <OrphanRow key={k} id={id} view={view} section="scenarios" entryKey={k} />)}
        {view.orphans.phrases.map((k) => <OrphanRow key={k} id={id} view={view} section="phrases" entryKey={k} />)}
        {view.uncommittedReview ? <div>Review state uncommitted — it is committed with the next decision or with "Record approval".</div> : null}
      </div>
    </div>
  )
}
