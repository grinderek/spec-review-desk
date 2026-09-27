import path from 'node:path'
import { parse } from 'yaml'
import { type DecisionChoiceInput, findDecision } from './decision-model.ts'
import { commitChangeDecision } from './decisions-md.ts'
import { approvedDomains, normalizeDomain } from './egress.ts'
import { HttpError } from './errors.ts'
import { INITIATIVE_FILE, InitiativeSchema, renderInitiative, withInitiativeLock } from './initiative-store.ts'
import { readReview } from './review-store.ts'
import type { RunTarget } from './run-service.ts'

// Initiative decisions use sub-project A's model in openspec/initiatives/<name>/review.yaml; they
// are all about the whole initiative, so deciding records them in its decisions.md (A §6).
// Ruling 3: a fetch-domains decision also appends the approved hosts to research.domains, committed
// in the same commit.
export async function decideInitiativeDecision(target: RunTarget, id: string, choice: DecisionChoiceInput, trailer: string): Promise<{ commit: string }> {
  const { wt, ini } = target
  const decision = findDecision(await readReview(ini.dir), id)
  if (decision.scope.kind !== 'change') throw new HttpError(409, 'not_change_scoped', `Decision ${id} is not about the initiative`)
  const requested = decision.requested_domains
  if (requested && choice.option === 'allow_some' && approvedDomains(requested, choice).length === 0) {
    throw new HttpError(422, 'domains_required', 'Name the hosts to allow in the note, e.g. "developer.intuit.com"')
  }
  const extra = requested
    ? [{
        file: path.join(ini.dir, INITIATIVE_FILE),
        rel: `${ini.relDir}/${INITIATIVE_FILE}`,
        content: (before: string | null) => {
          const doc = InitiativeSchema.parse(parse(before ?? ''))
          const approved = approvedDomains(requested, choice).flatMap((h) => normalizeDomain(h) ?? [])
          return renderInitiative({ ...doc, research: { domains: [...new Set([...doc.research.domains, ...approved])] } })
        },
      }]
    : []
  return withInitiativeLock(ini.dir, () =>
    commitChangeDecision({ cwd: wt.path, relDir: ini.relDir, changeDir: ini.dir, changeName: ini.name, decisionId: id, choice, trailer, now: new Date(), extra }))
}
