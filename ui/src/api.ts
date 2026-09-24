import type { ChangeSummary, ChangeView } from '../../server/change-view.ts'
import type { CorpusReport } from '../../server/corpus.ts'
import type { ApplyRun } from '../../server/review-store.ts'
import type { RunnerState } from '../../server/runner.ts'

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(error?.code ?? 'http_error', error?.message ?? res.statusText, res.status)
  }
  return json as T
}

export interface ChangeId { wt: string; name: string }
export interface WorktreeSummary { id: string; path: string; branch: string | null; head: string; changes: ChangeSummary[] }
export interface ChangesResponse { repos: { repo: string; worktrees: WorktreeSummary[] }[] }
export type Section = 'scenarios' | 'phrases'
export interface Capabilities { claude: boolean; docker: boolean }

const base = ({ wt, name }: ChangeId): string => `/api/changes/${wt}/${encodeURIComponent(name)}`
type Ok = { ok: boolean }

export const api = {
  status: () => request<{ capabilities: Capabilities }>('GET', '/api/status'),
  changes: () => request<ChangesResponse>('GET', '/api/changes'),
  change: (id: ChangeId) => request<ChangeView>('GET', base(id)),
  scenarioDiff: (id: ChangeId, key: string) =>
    request<{ before: string | null; after: string; approvedCommit: string | null }>('GET', `${base(id)}/scenario-diff?key=${encodeURIComponent(key)}`),
  corpus: (id: ChangeId) => request<CorpusReport>('GET', `${base(id)}/corpus`),
  approveScenario: (id: ChangeId, key: string) => request<Ok>('POST', `${base(id)}/scenarios/approve`, { key }),
  revokeScenario: (id: ChangeId, key: string) => request<Ok>('POST', `${base(id)}/scenarios/revoke`, { key }),
  requestChanges: (id: ChangeId, key: string, reason: string) => request<{ threadId: string }>('POST', `${base(id)}/scenarios/request-changes`, { key, reason }),
  approvePhrase: (id: ChangeId, key: string) => request<Ok>('POST', `${base(id)}/phrases/approve`, { key }),
  revokePhrase: (id: ChangeId, key: string) => request<Ok>('POST', `${base(id)}/phrases/revoke`, { key }),
  recordApproval: (id: ChangeId) => request<{ commit: string }>('POST', `${base(id)}/approval`),
  dropOrphan: (id: ChangeId, section: Section, key: string) => request<Ok>('POST', `${base(id)}/orphans/drop`, { section, key }),
  reattachOrphan: (id: ChangeId, section: Section, key: string, to: string) => request<Ok>('POST', `${base(id)}/orphans/reattach`, { section, key, to }),
  newThread: (id: ChangeId, body: { anchor: 'scenario' | 'phrase' | 'change'; ref: string; text: string }) =>
    request<{ id: string }>('POST', `${base(id)}/threads`, body),
  reply: (id: ChangeId, threadId: string, text: string) => request<Ok>('POST', `${base(id)}/threads/${threadId}/messages`, { text }),
  resolveThread: (id: ChangeId, threadId: string) => request<Ok>('POST', `${base(id)}/threads/${threadId}/resolve`),
  applyPatch: (id: ChangeId, threadId: string, index: number, summary: string) =>
    request<{ commit: string }>('POST', `${base(id)}/threads/${threadId}/patches/${index}/apply`, { summary }),
  recheckPatch: (id: ChangeId, threadId: string, index: number) =>
    request<{ state: string; error: string | null }>('POST', `${base(id)}/threads/${threadId}/patches/${index}/recheck`),
  rejectPatch: (id: ChangeId, threadId: string, index: number) => request<Ok>('POST', `${base(id)}/threads/${threadId}/patches/${index}/reject`),
  threadEventsUrl: (id: ChangeId, threadId: string) => `${base(id)}/threads/${threadId}/events`,
  runner: (wt: string) => request<{ state: RunnerState | null }>('GET', `/api/runner/${wt}`),
  startRunner: (wt: string) => request<{ state: RunnerState | null }>('POST', `/api/runner/${wt}/start`),
  runCorpus: (wt: string) => request<{ state: RunnerState | null }>('POST', `/api/runner/${wt}/run`),
  startApply: (id: ChangeId) => request<{ run: ApplyRun }>('POST', `${base(id)}/apply`),
  stopApply: (id: ChangeId) => request<Ok>('POST', `${base(id)}/apply/stop`),
  reapply: (id: ChangeId) => request<{ run: ApplyRun }>('POST', `${base(id)}/reapply`),
  runLog: (id: ChangeId, runId: string) => request<{ run: ApplyRun; text: string }>('GET', `${base(id)}/runs/${runId}/log`),
  runEventsUrl: (id: ChangeId, runId: string) => `${base(id)}/runs/${runId}/events`,
}
