import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Config, AgentRole } from './config.ts'
import type { RoutingDecision } from './agent-routing.ts'
export interface TokenUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface AgentAudit {
  id: string; type: 'started' | 'completed'; at: string; role: AgentRole; runId: string;
  worktreeId: string; target: string; resume: boolean; routing: RoutingDecision;
  startedAt?: string; completedAt?: string; durationMs?: number; ok?: boolean; usage?: TokenUsage | null; estimatedApiUsd?: number | null;
  actualBilledUsd?: null; agentStatus?: string; decisionsRaised?: number; toolCalls?: number;
}
const writes = new Map<string, Promise<void>>()
export const usagePath = (config: Config): string => path.join(config.usageDir ?? path.join(config.hubRoot, '.spec-review', 'usage'), 'agents.jsonl')
export function auditId(runId: string, attempt: string | number): string { return createHash('sha256').update(`${runId}:${attempt}`).digest('hex').slice(0,24) }
// Snapshot of standard text-token rates checked 2026-10-02. Estimates omit cache writes,
// tool fees, long-context multipliers and service tiers; they are never an invoice or plan usage.
export function estimateApiUsd(model: string, usage: TokenUsage | null): number | null {
  const rates: Record<string, [number, number, number]> = { 'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6-luna': [0.1, 0.01, 0.5] }
  const rate = rates[model]
  return usage && rate ? ((usage.inputTokens - usage.cachedInputTokens) * rate[0] + usage.cachedInputTokens * rate[1] + usage.outputTokens * rate[2]) / 1e6 : null
}
export async function appendAudit(config: Config, event: AgentAudit): Promise<void> {
  const file = usagePath(config)
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await appendFile(file, JSON.stringify(event) + '\n', { mode: 0o600 })
  })
  writes.set(file, next)
  try { await next } finally { if (writes.get(file) === next) writes.delete(file) }
}
export async function readUsage(config: Config) {
  const raw = await readFile(usagePath(config), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e })
  const records = raw.split('\n').flatMap((s): AgentAudit[] => { try { return s ? [JSON.parse(s)] : [] } catch { return [] } })
  const started = new Map<string, AgentAudit>(); const completed = new Map<string, AgentAudit>()
  for (const r of records) (r.type === 'started' ? started : completed).set(r.id,r)
  const attempts = [...new Set([...started.keys(), ...completed.keys()])].map(id => ({ ...started.get(id), ...completed.get(id), startedAt: started.get(id)?.at, completedAt: completed.get(id)?.at } as AgentAudit))
  const done = attempts.filter(r => r.type === 'completed')
  return { routing: config.routing ?? { enabled: false }, totals: {
    attempts: attempts.length, completed: done.length, unfinished: attempts.length - done.length,
    inputTokens: done.reduce((n,r) => n + (r.usage?.inputTokens ?? 0),0), cachedInputTokens: done.reduce((n,r) => n + (r.usage?.cachedInputTokens ?? 0),0), outputTokens: done.reduce((n,r) => n + (r.usage?.outputTokens ?? 0),0),
    estimatedApiUsd: done.reduce((n,r) => n + (r.estimatedApiUsd ?? 0),0),
    unknownUsage: done.filter(r => !r.usage).length, unpricedAttempts: done.filter(r => r.estimatedApiUsd == null).length,
    actualBilledUsd: null, pricingDate: '2026-10-02',
  }, attempts: attempts.reverse().slice(0,200) }
}
