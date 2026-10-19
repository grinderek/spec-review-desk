import { type DecisionChoiceInput, findDecision } from './decision-model.ts'
import { commitChangeDecision } from './decisions-md.ts'
import { approvedDomains, normalizeDomain } from './egress.ts'
import { HttpError } from './errors.ts'
import { withGitEffectLock } from './git-effect.ts'
import { executeInitiativeCommand } from './initiative-commands.ts'
import { withInitiativeLock } from './initiative-store.ts'
import { readReview } from './review-store.ts'
import type { RunTarget } from './run-service.ts'

// Review choice and initiative permission are correlated steps, not a transaction across streams.
// Repeating the owner command returns the recorded commit and idempotently repairs a missing grant.
export function decideInitiativeDecision(target: RunTarget, id: string, choice: DecisionChoiceInput, trailer: string): Promise<{ commit: string }> {
  const { wt, ini } = target
  return withGitEffectLock(wt.path, () => withInitiativeLock(ini.dir, async () => {
    const decision = findDecision(await readReview(ini.dir), id)
    if (decision.scope.kind !== 'change') throw new HttpError(409, 'not_change_scoped', `Decision ${id} is not about the initiative`)
    const requested = decision.requested_domains
    if (requested && choice.option === 'allow_some' && approvedDomains(requested, choice).length === 0) throw new HttpError(422, 'domains_required', 'Name the hosts to allow in the note')
    const result = await commitChangeDecision({ cwd: wt.path, relDir: ini.relDir, changeDir: ini.dir, changeName: ini.name, decisionId: id, choice, trailer, now: new Date() })
    if (requested) await executeInitiativeCommand(ini.dir, { type: 'grant-domains',
      domains: approvedDomains(requested, choice).flatMap(h => normalizeDomain(h) ?? []), decision: id, commit: result.commit })
    return result
  }))
}
