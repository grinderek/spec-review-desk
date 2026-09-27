import type { DecisionView } from '../../server/change-view.ts'
import type { DecisionLogEntry } from '../../server/decisions-md.ts'

export type InboxFilter = 'open' | 'all'
export interface HistoryItem { kind: 'gherkin' | 'decisions_md'; date: string; title: string; text: string; commit: string | null; key: string | null }
interface FeatureLike {
  scenarios: readonly { key: string; title: string; decisions: readonly { date: string; text: string; commit: string | null }[] }[]
}

export const isActive = (d: Pick<DecisionView, 'status'>): boolean => d.status === 'open' || d.status === 'decided'

// Spec §11: open and decided first, blocking first, then newest first.
export function inbox(decisions: readonly DecisionView[], filter: InboxFilter): DecisionView[] {
  const rank = (d: DecisionView): number => (isActive(d) ? 0 : 2) + (d.blocking ? 0 : 1)
  return decisions
    .filter((d) => filter === 'all' || isActive(d))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || b.d.created_at.localeCompare(a.d.created_at) || a.i - b.i)
    .map(({ d }) => d)
}

// One timeline for the Gherkin "# Owner decision" comments and the decisions.md entries.
export function history(features: readonly FeatureLike[], log: readonly DecisionLogEntry[]): HistoryItem[] {
  const gherkin = features.flatMap((f) =>
    f.scenarios.flatMap((s) =>
      s.decisions.map((d): HistoryItem => ({ kind: 'gherkin', date: d.date, title: s.title, text: d.text, commit: d.commit, key: s.key }))))
  const md = log.map((e): HistoryItem => ({
    kind: 'decisions_md',
    date: e.date,
    title: e.question,
    text: [e.decision, e.note ? `Note: ${e.note}` : ''].filter(Boolean).join(' — '),
    commit: null,
    key: null,
  }))
  return [...gherkin, ...md]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.date.localeCompare(a.item.date) || a.i - b.i)
    .map(({ item }) => item)
}

export const scenarioTitle = (key: string): string => key.split('::').slice(1).join('::') || key

export const scopeLabel = (d: Pick<DecisionView, 'scope'>): string =>
  d.scope.kind === 'scenario' ? `Scenario: ${scenarioTitle(d.scope.key)}` : 'Whole change'

export function sourceLabel(d: Pick<DecisionView, 'source'>): string {
  if (d.source.kind === 'thread') return 'raised in a thread'
  if (d.source.kind === 'apply') return `raised by Apply ${d.source.run}`
  return 'added by you'
}

export function choiceLabel(d: DecisionView): string {
  const option = d.options.find((o) => o.id === d.choice?.option)
  return option?.label ?? d.choice?.note ?? ''
}

export function outcomeLine(d: DecisionView): string | null {
  if (d.status === 'decided') return `Decided: ${choiceLabel(d)} — waiting for the agent's patch`
  if (d.status === 'recorded') {
    const where = d.recorded?.how === 'patch' ? 'recorded by patch' : 'recorded in decisions.md'
    return `${choiceLabel(d)} — ${where} · ${d.recorded?.commit ?? 'uncommitted'}`
  }
  if (d.status === 'dismissed') return `Dismissed: ${d.dismissed?.reason ?? ''}`
  return null
}

// Option ids must be slugs (server/protocol.ts SLUG); labels may be in any language.
export function optionIds(labels: readonly string[]): string[] {
  return labels.reduce<string[]>((ids, label, i) => {
    const base = label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || `option_${i + 1}`
    return [...ids, ids.includes(base) ? `${base}_${i + 1}` : base]
  }, [])
}
