import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { RoutingDecision } from '../../server/agent-routing.ts'
import { api } from './api.ts'
export function RunProfile({ routing }: { routing?: RoutingDecision }) {
  return routing ? <p className="note">{routing.model} · {routing.reasoningEffort} · {routing.source}: {routing.reason}</p> : null
}
export function AgentUsage() {
  const [open, setOpen] = useState(false)
  const query = useQuery({ queryKey: ['agent-usage'], queryFn: api.usage, enabled: open, refetchInterval: open ? 5000 : false })
  const data = query.data
  const download = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'desk-agent-usage.json'; a.click(); URL.revokeObjectURL(url)
  }
  return <details className="agent-usage" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Agent usage & routing</summary>
    {query.error ? <p className="fail">Could not read the usage journal.</p> : !data ? <p>Loading…</p> : <>
      <p>Kev: {data.router.enabled ? data.router.ready ? `ready (${data.router.model})` : 'unavailable — Sol fallback' : 'disabled'} · {data.totals.attempts} attempts · {data.totals.unfinished} unfinished</p>
      <p>Input: {data.totals.inputTokens.toLocaleString()} · cached: {data.totals.cachedInputTokens.toLocaleString()} · output: {data.totals.outputTokens.toLocaleString()} · API text-token estimate: ${data.totals.estimatedApiUsd.toFixed(5)}</p>
      <p className="note">Actual billing is not reported by Codex. This estimate uses standard API text-token rates checked {data.totals.pricingDate}; it is not subscription spend or allowance usage. Tool fees, cache writes and tier/context surcharges are excluded. {data.totals.unknownUsage} completed attempts have unknown token usage; {data.totals.unpricedAttempts} are unpriced. Local Kev has no API charge; electricity is not measured. History starts when logging was enabled.</p>
      <button className="btn" onClick={download}>Export recent journal</button>
      <div style={{ overflowX: 'auto', maxHeight: 420 }}><table>
        <thead><tr><th>Started / target</th><th>Role / profile</th><th>Decision</th><th>Attempt</th><th>Tokens in / cached / out</th><th>API estimate</th></tr></thead>
        <tbody>{data.attempts.map(r => <tr key={r.id}>
          <td>{r.startedAt ?? r.at}<br/>{r.target}<br/><small>{r.worktreeId} · {r.runId}</small></td>
          <td>{r.role}<br/>{r.routing.model} / {r.routing.reasoningEffort}</td>
          <td><details><summary>{r.routing.source} · {r.routing.durationMs} ms</summary>{r.routing.reason}<br/>{r.routing.routerModel}<br/>{r.routing.probabilities ? JSON.stringify(r.routing.probabilities) : null}<br/>confidence: {r.routing.confidence ?? '—'}<br/>state: {r.routing.stateHash}</details></td>
          <td>{r.type === 'started' ? 'unfinished' : r.ok ? 'CLI completed' : 'CLI failed'}{r.resume ? ' · resume/retry' : ''}<br/>{r.durationMs == null ? '—' : `${(r.durationMs/1000).toFixed(1)} s`} · tools: {r.toolCalls ?? '—'}</td>
          <td>{r.usage ? `${r.usage.inputTokens} / ${r.usage.cachedInputTokens} / ${r.usage.outputTokens}` : 'unknown'}</td>
          <td>{r.estimatedApiUsd == null ? 'unknown' : `$${r.estimatedApiUsd.toFixed(5)}`}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="note">Latest 200 attempts shown. Totals cover the full persisted journal. Owner decisions remain in each change’s Decisions tab and approval journal.</p>
    </>}
  </details>
}
