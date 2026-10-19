import { z } from 'zod'
import { GitEffectPlanSchema } from './git-effect.ts'

export const InitiativeOwnerGitSchemas = [
  z.object({ type:z.literal('InitiativeOwnerGitRequested'), operation:z.enum(['brief','inputs','research-accept','domains','plan-approval','creation']),
    requestHash:z.string().regex(/^[0-9a-f]{64}$/), result:z.record(z.string(),z.unknown()), plan:GitEffectPlanSchema }),
  z.object({ type:z.literal('InitiativeOwnerGitCompleted'), effectId:z.uuid(), commit:z.string() }),
  z.object({ type:z.literal('InitiativeOwnerGitObserved'), effectId:z.uuid(), status:z.enum(['pending','uncertain','failed','not_started']), reason:z.string() }),
] as const
export const InitiativeOwnerGitEventSchema=z.discriminatedUnion('type',InitiativeOwnerGitSchemas)
export type InitiativeOwnerGitEvent=z.infer<typeof InitiativeOwnerGitEventSchema>
export const InitiativeOwnerGitStateSchema=z.object({
  operation:InitiativeOwnerGitSchemas[0].shape.operation,
  requestHash:z.string(),result:z.record(z.string(),z.unknown()),plan:GitEffectPlanSchema,
  status:z.enum(['requested','completed','pending','uncertain','failed','not_started']),commit:z.string().nullable(),reason:z.string().nullable(),
})
export type InitiativeOwnerGitState=z.infer<typeof InitiativeOwnerGitStateSchema>
export function projectInitiativeOwnerGit(states:InitiativeOwnerGitState[],event:InitiativeOwnerGitEvent):void {
  if(event.type==='InitiativeOwnerGitRequested') {
    if(states.some(state=>state.plan.effectId===event.plan.effectId))throw new Error('Duplicate initiative owner Git effect')
    states.push({operation:event.operation,requestHash:event.requestHash,result:structuredClone(event.result),plan:structuredClone(event.plan),status:'requested',commit:null,reason:null});return
  }
  const state=states.find(state=>state.plan.effectId===event.effectId)
  if(!state)throw new Error('Unknown initiative owner Git effect')
  if(state.status==='completed')throw new Error('Initiative owner Git effect already completed')
  if(event.type==='InitiativeOwnerGitCompleted'){state.status='completed';state.commit=event.commit;state.reason=null}
  else {state.status=event.status;state.reason=event.reason}
}
