import { isActive } from './decision-model.ts'
import { decisionsSection, scenarioKeysSection } from './prompt.ts'
import type { DecisionRecord } from './review-store.ts'
export { NEEDS_OWNER, outcomeOf, readEvents } from './apply-outcome.ts'
export { ApplyService } from './apply-execution.ts'
export const DEFAULT_APPLY_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
]
// Denied command prefixes are removed before exposing the scoped MCP command tool.
export const DEFAULT_APPLY_DENY = [
  'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(rm:*)',
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'WebFetch', 'WebSearch',
]

export function applyPrompt(
  changeName: string,
  onlyKeys: readonly string[],
  decisions: readonly DecisionRecord[] = [],
  scenarioKeys: readonly string[] = [],
): string {
  const lines = [`Implement the owner-approved OpenSpec change "${changeName}".`, `Read openspec/changes/${changeName}/proposal.md, specs/ and features/ before making changes.`, "Follow the repository AGENTS.md and the OpenSpec apply skill under .agents/skills/ when present.", "Implement the approved scenarios, run the configured checks and commit the implementation."]
  if (onlyKeys.length) {
    lines.push(
      '',
      'The owner approved changes to scenarios that are already implemented. The living corpus under',
      'features/ differs from the change for exactly these scenarios. Bring the corpus, the step',
      'definitions and the code in line with them, RED first:',
      ...onlyKeys.map((k) => `- ${k}`),
    )
  }
  // Final review Important 1(a): the Apply prompt carried no scenario keys at all unless it was a
  // reapply, so a scenario-scoped `needs_owner` decision invented its own key.
  if (scenarioKeys.length) lines.push('', ...scenarioKeysSection(scenarioKeys))
  if (decisions.some(isActive)) lines.push('', ...decisionsSection(decisions))
  return lines.join('\n')
}
