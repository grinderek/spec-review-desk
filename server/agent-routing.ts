import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentProfile, type AgentRole, type Config } from './config.ts'

export const RoutingDecisionSchema = z.object({
  version: z.literal(1), at: z.string(), source: z.enum(['kev', 'policy', 'fallback', 'fixed']),
  model: z.string(), reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  profile: z.string(), reason: z.string(), stateHash: z.string(), durationMs: z.number(),
  routerModel: z.string().optional(), confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(), inputTokens: z.number().optional(),
})
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>
const profiles = {
  luna_medium: { model: 'gpt-6-luna', reasoningEffort: 'medium' as const },
  sol_medium: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' as const },
  sol_high: { model: 'gpt-6.1-sol', reasoningEffort: 'high' as const },
}
const criteria = {
  luna_medium: 'Small, clear task: isolated edit or simple fact lookup. No architecture or security changes.',
  sol_medium: 'Moderate task: several files or dependencies, debugging or comparison of alternatives with incomplete evidence.',
  sol_high: 'Complex task: architecture, security, authentication, payments, data migrations, conflicting requirements, or several systems.',
}
const AnswerSchema = z.object({ model: z.string(), answers: z.object({ profile: z.object({
  choice: z.enum(['luna_medium', 'sol_medium', 'sol_high']), confidence: z.number().min(0).max(1),
  probabilities: z.object({ luna_medium: z.number().min(0).max(1), sol_medium: z.number().min(0).max(1), sol_high: z.number().min(0).max(1) }),
}) }), usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional() })

// Task text stays in memory and goes only to the configured loopback Kev endpoint. The audit
// stores a fingerprint and numeric evidence, never prompts, documents, credentials or model prose.
export async function selectAgent(config: Config, role: AgentRole, task: string): Promise<RoutingDecision> {
  const started = Date.now()
  const state = { role, task: task.slice(0, 12000) }
  const base = { version: 1 as const, at: new Date().toISOString(), stateHash: createHash('sha256').update(JSON.stringify(state)).digest('hex') }
  const decision = (source: RoutingDecision['source'], profile: string, reason: string, selected = agentProfile(config, role), extra = {}): RoutingDecision =>
    ({ ...base, source, profile, reason, ...selected, durationMs: Date.now() - started, ...extra })
  if (!config.routing?.enabled || !config.routing.roles.includes(role)) return decision('fixed', role, 'Configured role profile')
  // A known high-impact task cannot be downgraded by a probabilistic classifier.
  const riskText = task.replace(/\bno (?:changes? to )?(?:security|authentication|payments?|migrations?)(?: or architecture)?(?: changes?| work)?\b/gi, '')
  if (/\b(security|authentication|tenant isolation|payment|migration)\b|авторизац|безопасност|изоляци.{0,20}клиент|миграци|плат[её]ж/i.test(riskText))
    return decision('policy', 'sol_high', 'High-impact task requires Sol/high', profiles.sol_high)
  if (task.length > 12000) return decision('policy', 'sol_high', 'Task exceeds routing context budget', profiles.sol_high)
  try {
    const response = await fetch(config.routing.endpoint + '/v1/systemone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(config.routing.timeoutMs), redirect: 'error',
      body: JSON.stringify({ model: 'kev-latest', state, questions: { profile: { type: 'choice', instructions: 'Choose the cheapest execution profile sufficient to complete this task reliably, considering complexity and risks.', criteria } } }),
    })
    if (!response.ok) throw new Error('router_http')
    const parsed = AnswerSchema.parse(await response.json())
    const answer = parsed.answers.profile
    const total = Object.values(answer.probabilities).reduce((a,b) => a+b,0)
    if (Math.abs(total - 1) > 0.02 || answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities))) throw new Error('router_invalid')
    let routerModel = parsed.model
    try {
      const metadata = await fetch(config.routing.endpoint + '/v1/models', { signal: AbortSignal.timeout(1000), redirect: 'error' })
      const models = z.object({ models: z.array(z.object({ run: z.string().optional() })) }).parse(await metadata.json())
      if (metadata.ok) routerModel = models.models[0]?.run ?? routerModel
    } catch { /* classification evidence remains usable without optional checkpoint metadata */ }
    const extra = { routerModel, confidence: answer.confidence, probabilities: answer.probabilities, ...(parsed.usage ? { inputTokens: parsed.usage.input_tokens } : {}) }
    if (answer.choice === 'luna_medium' && answer.probabilities.luna_medium < config.routing.minLunaProbability)
      return decision('fallback', 'sol_medium', 'Luna probability below configured pilot threshold', profiles.sol_medium, extra)
    return decision('kev', answer.choice, 'Kev selected the execution profile', profiles[answer.choice], extra)
  } catch {
    return decision('fallback', 'sol_high', 'Kev unavailable, timed out, or returned invalid evidence', profiles.sol_high)
  }
}
