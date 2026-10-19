import { inspectVerificationContainer, removeTerminalVerificationContainer } from './verification-container.ts'
import { decideVerificationCleanupObservation, type VerificationCleanupEvent, type VerificationCleanupState } from './verification-cleanup-model.ts'

export interface VerificationCleanupJournal {
  // The parent stream owns serialization, event persistence and projection. Docker operations
  // below run only while this transaction holds the already recorded intent's scope lock.
  update<T>(decide: (state: VerificationCleanupState) => Promise<{ events: VerificationCleanupEvent[]; value: T }>): Promise<T>
}
const reason = (error: unknown): string => error instanceof Error ? error.message || error.name : String(error)

export async function executeVerificationCleanup(cwd: string, attemptId: string, journal: VerificationCleanupJournal): Promise<'completed' | 'blocked'> {
  return journal.update(async state => {
    const intent = state[attemptId]
    if (!intent) throw new Error('Verification cleanup was not requested')
    if (intent.status === 'completed') return { events: [], value: 'completed' }
    try {
      await removeTerminalVerificationContainer(cwd, intent.runId, intent.attemptId, { name: intent.name, id: intent.containerId })
      return { events: decideVerificationCleanupObservation(intent, 'missing'), value: 'completed' }
    } catch (error) {
      return { events: decideVerificationCleanupObservation(intent, { reason: reason(error) }), value: 'blocked' }
    }
  })
}

// Startup/replay may observe that an already requested deletion finished. It never issues rm,
// stops a process, deletes artifacts, or turns a live/unknown container into an accepted result.
export async function reconcileVerificationCleanups(cwd: string, journal: VerificationCleanupJournal): Promise<void> {
  await journal.update(async state => {
    const events: VerificationCleanupEvent[] = []
    for (const intent of Object.values(state)) {
      if (intent.status === 'completed') continue
      try {
        const observed = await inspectVerificationContainer(cwd, intent.runId, intent.attemptId, { name: intent.name, id: intent.containerId })
        if (observed.kind === 'missing') events.push(...decideVerificationCleanupObservation(intent, 'missing'))
        else if (observed.kind === 'live') events.push(...decideVerificationCleanupObservation(intent, { reason: `Verification container is not safely terminal: ${observed.status}` }))
      } catch (error) { events.push(...decideVerificationCleanupObservation(intent, { reason: reason(error) })) }
    }
    return { events, value: undefined }
  })
}
