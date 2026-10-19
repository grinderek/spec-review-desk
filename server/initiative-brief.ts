import { initiativeCommitMessage } from './initiative-git.ts'
import type { RunTarget } from './run-service.ts'
import { storeInitiativeBlob } from './initiative-events.ts'
import { executeInitiativeOwnerOperation, initiativeBlobOutputs, initiativeOwnerGitInput, ownerRequestHash } from './initiative-owner-effects.ts'

export const BRIEF_FILE = 'brief.md'
export const MAX_BRIEF_CHARS = 20_000
export function briefText(brief: string): string {
  const text = brief.replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}
export const briefFits = (brief: string): boolean => briefText(brief).length <= MAX_BRIEF_CHARS
export async function saveBrief(target: RunTarget, brief: string, trailer: string): Promise<{ brief: string; commit: string | null }> {
  const text = briefText(brief)
  const saved = await executeInitiativeOwnerOperation(target, { operation: 'brief', requestHash: ownerRequestHash({ brief: text }), prepare: async () => {
    const blob = await storeInitiativeBlob(target.ini.dir, text)
    return { command: { type: 'save-brief', blob }, result: { brief: text }, noChange: true,
      git: async next => initiativeOwnerGitInput(target, next, 'brief', initiativeCommitMessage(`${target.ini.name} - brief`, trailer), initiativeBlobOutputs(target, blob, BRIEF_FILE)) }
  } })
  return { brief: String(saved.result.brief), commit: saved.commit }
}
