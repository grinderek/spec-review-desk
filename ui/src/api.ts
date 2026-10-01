import type { ChangeSummary, ChangeView } from '../../server/change-view.ts'
import type { InitiativeSummary, InitiativeView } from '../../server/initiatives.ts'
import type { Plan, RunRecord } from '../../server/initiative-store.ts'
import type { CorpusReport } from '../../server/corpus.ts'
import type { ApplyRun } from '../../server/review-store.ts'
import type { RunnerState } from '../../server/runner.ts'
import type { SandboxStatus } from '../../server/sandbox.ts'
import type { SliceEdit } from '../../server/slice-plan.ts'

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData
  const res = await fetch(url, {
    method,
    headers: body === undefined || form ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(error?.code ?? 'http_error', error?.message ?? res.statusText, res.status)
  }
  return json as T
}

// A text body (an input shown in the viewer); errors carry the same envelope as request().
async function requestText(url: string): Promise<string> {
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    let error: { code?: string; message?: string } | undefined
    try {
      error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error
    } catch {
      error = undefined
    }
    throw new ApiError(error?.code ?? 'http_error', error?.message ?? res.statusText, res.status)
  }
  return text
}

export interface ChangeId { wt: string; name: string }
export interface WorktreeSummary { id: string; path: string; branch: string | null; head: string; changes: (ChangeSummary & { initiative: string | null })[] }
export interface ChangesResponse { repos: { repo: string; worktrees: WorktreeSummary[] }[] }
export type Section = 'scenarios' | 'phrases'
export interface Capabilities { codex: boolean; docker: boolean }
export interface NewDecisionBody {
  question: string
  scope: { kind: 'scenario'; key: string } | { kind: 'change' }
  blocking: boolean
  options: { id: string; label: string; consequence: string }[]
}
export type DecideResponse = { status: 'recorded'; commit: string } | { status: 'decided'; threadId: string }

const base = ({ wt, name }: ChangeId): string => `/api/changes/${wt}/${encodeURIComponent(name)}`
type Ok = { ok: boolean }

// Spec B: an initiative is addressed like a change — worktree id + name.
export type InitiativeId = ChangeId
const ibase = ({ wt, name }: InitiativeId): string => `/api/initiatives/${wt}/${encodeURIComponent(name)}`
export type { InitiativeSummary, InitiativeView, RunRecord, SandboxStatus, SliceEdit }
export interface RepoChoice { name: string; path: string; worktrees: { id: string; path: string; branch: string | null }[] }
export interface InitiativesResponse { initiatives: InitiativeSummary[]; repos: RepoChoice[]; defaultBase: string }

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
  runner: (wt: string) => request<{ state: RunnerState | null }>('GET', `/api/runner/${wt}`),
  startRunner: (wt: string) => request<{ state: RunnerState | null }>('POST', `/api/runner/${wt}/start`),
  runCorpus: (wt: string) => request<{ state: RunnerState | null }>('POST', `/api/runner/${wt}/run`),
  startApply: (id: ChangeId) => request<{ run: ApplyRun }>('POST', `${base(id)}/apply`),
  stopApply: (id: ChangeId) => request<Ok>('POST', `${base(id)}/apply/stop`),
  reapply: (id: ChangeId) => request<{ run: ApplyRun }>('POST', `${base(id)}/reapply`),
  runLog: (id: ChangeId, runId: string) => request<{ run: ApplyRun; text: string }>('GET', `${base(id)}/runs/${runId}/log`),
  addDecision: (id: ChangeId, body: NewDecisionBody) => request<{ id: string }>('POST', `${base(id)}/decisions`, body),
  decide: (id: ChangeId, decisionId: string, body: { option: string | null; note: string }) =>
    request<DecideResponse>('POST', `${base(id)}/decisions/${decisionId}/decide`, body),
  dismissDecision: (id: ChangeId, decisionId: string, reason: string) => request<Ok>('POST', `${base(id)}/decisions/${decisionId}/dismiss`, { reason }),
  reattachDecision: (id: ChangeId, decisionId: string, to: string) => request<Ok>('POST', `${base(id)}/decisions/${decisionId}/reattach`, { to }),
  resumeApply: (id: ChangeId, runId: string) => request<Ok>('POST', `${base(id)}/apply/resume`, { runId }),
  initiatives: () => request<InitiativesResponse>('GET', '/api/initiatives'),
  initiative: (id: InitiativeId) => request<InitiativeView>('GET', ibase(id)),
  sandboxStatus: () => request<SandboxStatus>('GET', '/api/sandbox/status'),
  createInitiative: (form: FormData) => request<{ worktreeId: string; name: string }>('POST', '/api/initiatives', form),
  saveBrief: (id: InitiativeId, brief: string) => request<{ brief: string; commit: string | null }>('PUT', `${ibase(id)}/brief`, { brief }),
  uploadInputs: (id: InitiativeId, form: FormData) => request<{ files: string[] }>('POST', `${ibase(id)}/inputs`, form),
  addFromRepo: (id: InitiativeId, from: string) => request<{ files: string[] }>('POST', `${ibase(id)}/inputs`, { from }),
  inputUrl: (id: InitiativeId, file: string) => `${ibase(id)}/inputs/${encodeURIComponent(file)}`,
  inputText: (id: InitiativeId, file: string) => requestText(`${ibase(id)}/inputs/${encodeURIComponent(file)}`),
  acceptDraft: (id: InitiativeId, file: string) => request<{ commit: string }>('POST', `${ibase(id)}/inputs/${encodeURIComponent(file)}/accept`),
  discardDraft: (id: InitiativeId, file: string) => request<Ok>('POST', `${ibase(id)}/inputs/${encodeURIComponent(file)}/discard`),
  startResearch: (id: InitiativeId, body: { topic: string; questions: string }) => request<{ run: RunRecord }>('POST', `${ibase(id)}/research`, body),
  setDomains: (id: InitiativeId, domains: string[]) => request<{ domains: string[] }>('PUT', `${ibase(id)}/research/domains`, { domains }),
  runPlanner: (id: InitiativeId) => request<{ run: RunRecord }>('POST', `${ibase(id)}/plan/run`),
  savePlan: (id: InitiativeId, slices: SliceEdit[]) => request<{ plan: Plan }>('PUT', `${ibase(id)}/plan`, { slices }),
  approvePlan: (id: InitiativeId) => request<{ commit: string }>('POST', `${ibase(id)}/plan/approve`),
  proposeSlice: (id: InitiativeId, sliceId: string, body: { notes: string; change?: string }) =>
    request<{ run: RunRecord }>('POST', `${ibase(id)}/slices/${sliceId}/propose`, body),
  stopRun: (id: InitiativeId, runId: string) => request<Ok>('POST', `${ibase(id)}/runs/${runId}/stop`),
  resumeRun: (id: InitiativeId, runId: string) => request<Ok>('POST', `${ibase(id)}/runs/${runId}/resume`),
  initiativeRunLog: (id: InitiativeId, runId: string) => request<{ run: RunRecord; text: string }>('GET', `${ibase(id)}/runs/${runId}/log`),

}

// The decision actions of sub-project A, for a change or for an initiative (spec B §9).
export interface DecisionClient {
  add: (body: NewDecisionBody) => Promise<{ id: string }>
  decide: (decisionId: string, body: { option: string | null; note: string }) => Promise<DecideResponse>
  dismiss: (decisionId: string, reason: string) => Promise<Ok>
  reattach: ((decisionId: string, to: string) => Promise<Ok>) | null
}

export const changeDecisions = (id: ChangeId): DecisionClient => ({
  add: (body) => api.addDecision(id, body),
  decide: (decisionId, body) => api.decide(id, decisionId, body),
  dismiss: (decisionId, reason) => api.dismissDecision(id, decisionId, reason),
  reattach: (decisionId, to) => api.reattachDecision(id, decisionId, to),
})

export const initiativeDecisions = (id: InitiativeId): DecisionClient => ({
  add: (body) => request<{ id: string }>('POST', `${ibase(id)}/decisions`, { question: body.question, blocking: body.blocking, options: body.options }),
  decide: (decisionId, body) => request<DecideResponse>('POST', `${ibase(id)}/decisions/${decisionId}/decide`, body),
  dismiss: (decisionId, reason) => request<Ok>('POST', `${ibase(id)}/decisions/${decisionId}/dismiss`, { reason }),
  reattach: null,
})
