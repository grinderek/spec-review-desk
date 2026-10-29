import { HttpError } from './errors.ts'
import { queueExecution } from './execution-model.ts'
import { recordReviewEvents, type ReviewDomainEvent, type Message, type ReviewDoc, type Thread } from './review-store.ts'

export type DiscussionCommand =
  | { type: 'OpenDiscussion'; thread: Thread }
  | { type: 'ReplyToDiscussion'; threadId: string; message: Message }
  | { type: 'AgentReply'; threadId: string; message: Message; status: 'open' | 'answered' }
  | { type: 'ResolveDiscussion'; threadId: string }
  | { type: 'SetReviewAgentSession'; session: string }

// Commands decide new facts; replay never invokes models, Git or notifications.
export function decideDiscussion(doc: ReviewDoc, command: DiscussionCommand): ReviewDomainEvent[] {
  if (command.type === 'OpenDiscussion') {
    if (doc.threads.some(t => t.id === command.thread.id)) throw new HttpError(409, 'discussion_exists', `Discussion ${command.thread.id} already exists`)
    return [{ type: 'DiscussionOpened', thread: command.thread }, ...(command.thread.anchor !== 'apply' && command.thread.messages.at(-1)?.role === 'owner'
      ? [queueExecution('reviewer', command.thread.id, command.thread.messages.length)] : [])]
  }
  if (command.type === 'SetReviewAgentSession') return doc.agent_session === command.session ? [] : [{ type: 'ReviewAgentSessionSet', session: command.session }]
  const thread = doc.threads.find(t => t.id === command.threadId)
  if (!thread) throw new HttpError(404, 'unknown_thread', `No thread ${command.threadId}`)
  if (command.type === 'ResolveDiscussion') return thread.status === 'resolved' ? [] : [{ type: 'DiscussionResolved', threadId: thread.id }]
  if (command.type === 'ReplyToDiscussion') return [{ type: 'DiscussionOwnerReplied', threadId: thread.id, message: command.message },
    ...(thread.anchor !== 'apply' ? [queueExecution('reviewer', thread.id, thread.messages.length + 1)] : [])]
  return [{ type: 'DiscussionAgentReplied', threadId: thread.id, message: command.message, status: command.status }]
}

// The optional mutation is restricted by the store to fields not yet migrated (decisions/runs).
export async function executeDiscussionCommand(dir: string, command: DiscussionCommand, mixed?: (doc: ReviewDoc) => ReviewDoc): Promise<void> {
  await recordReviewEvents(dir, async doc => ({ events: decideDiscussion(doc, command), review: mixed?.(doc) }))
}
