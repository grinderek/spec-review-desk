import { createHash } from 'node:crypto'
import { HttpError } from './errors.ts'
import { assertWorktreeAdmission,withWorktreeAdmission } from './execution-admission.ts'
import { executeGitEffect,prepareGitEffect,reconcileGitEffect,type GitEffectInput } from './git-effect.ts'
import { decideInitiative,type InitiativeCommand } from './initiative-commands.ts'
import { projectInitiative,readInitiativeStream,recordInitiativeEvents,type InitiativeEvent,type InitiativeEventPayload,type InitiativeStream } from './initiative-events.ts'
import { InitiativeOwnerGitEventSchema,type InitiativeOwnerGitEvent,type InitiativeOwnerGitState } from './initiative-owner-effect-model.ts'
import { readInitiative,withInitiativeLock,type InitiativeDoc } from './initiative-store.ts'
import type { RunTarget } from './run-service.ts'

export const ownerRequestHash=(request:unknown):string=>createHash('sha256').update(JSON.stringify(request)).digest('hex')
export function initiativeOwnerGitInput(target:RunTarget,next:InitiativeDoc,operation:string,message:string,outputs:GitEffectInput['outputs']=[]):GitEffectInput {
  // Bind the exact business state without hashing a journal into its own Git intent.
  const content=Buffer.from(JSON.stringify({name:next.name,title:next.title,repo:next.repo,created_at:next.created_at,inputs:next.inputs,research:next.research,plan:next.plan})+'\n')
  const digest=createHash('sha256').update(content).digest('hex')
  return {purpose:{kind:'initiative-owner',ref:`${target.ini.name}:${operation}`},message,
    outputs:[...outputs,{path:`${target.ini.relDir}/states/${digest}.json`,content,mode:0o644}],
    extraFiles:[`${target.ini.relDir}/initiative.events.jsonl`,`${target.ini.relDir}/initiative.yaml`]}
}
export function initiativeBlobOutputs(target:RunTarget,blob:string,view?:string):GitEffectInput['outputs'] {
  const source={path:`${target.ini.relDir}/blobs/${blob}`,hash:blob}
  return [{path:source.path,source,mode:0o644},...(view?[{path:`${target.ini.relDir}/${view}`,source,mode:0o644}]:[])]
}
interface OwnerOperation {
  operation:InitiativeOwnerGitState['operation'];requestHash:string
  prepare(doc:InitiativeDoc,at:string):Promise<{
    command:InitiativeCommand;result:Record<string,unknown>
    git(next:InitiativeDoc):Promise<GitEffectInput>
    noChange?:boolean
  }>
}
function ownerEvents(stream:InitiativeStream):InitiativeOwnerGitEvent[] {
  return stream.events.flatMap(({event})=>{const parsed=InitiativeOwnerGitEventSchema.safeParse(event);return parsed.success?[parsed.data]:[]})
}
function completed(events:InitiativeOwnerGitEvent[],id:string):boolean{return events.some(event=>event.type==='InitiativeOwnerGitCompleted'&&event.effectId===id)}
async function appendOwner(target:RunTarget,stream:InitiativeStream,events:InitiativeOwnerGitEvent[],at:string,domain:InitiativeEventPayload[]=[]):Promise<void> {
  await recordInitiativeEvents(target.ini.dir,stream,[...events,...domain],at)
}
async function finishOwnerEffect(target:RunTarget,requested:Extract<InitiativeOwnerGitEvent,{type:'InitiativeOwnerGitRequested'}>,execute:boolean):Promise<{result:Record<string,unknown>;commit:string}> {
  let stream=await readInitiativeStream(target.ini.dir)
  const done=ownerEvents(stream).find(event=>event.type==='InitiativeOwnerGitCompleted'&&event.effectId===requested.plan.effectId)
  if(done?.type==='InitiativeOwnerGitCompleted')return {result:requested.result,commit:done.commit}
  let receipt=await reconcileGitEffect(target.wt.path,requested.plan)
  if(execute&&receipt.status!=='completed') {
    await assertWorktreeAdmission(target.wt.path,{operation:'git',effectId:requested.plan.effectId})
    receipt=await executeGitEffect(target.wt.path,requested.plan,{resumePending:true})
  }
  stream=await readInitiativeStream(target.ini.dir)
  const at=new Date().toISOString()
  if(receipt.status==='completed') {
    await appendOwner(target,stream,[{type:'InitiativeOwnerGitCompleted',effectId:receipt.effectId,commit:receipt.commit}],at)
    return {result:requested.result,commit:receipt.commit}
  }
  const previous=ownerEvents(stream).findLast(event=>'effectId'in event&&event.effectId===receipt.effectId)
  if(previous?.type!=='InitiativeOwnerGitObserved'||previous.status!==receipt.status||previous.reason!==receipt.reason)await appendOwner(target,stream,[{type:'InitiativeOwnerGitObserved',effectId:receipt.effectId,status:receipt.status,reason:receipt.reason}],at)
  throw new HttpError(409,'initiative_git_pending',`Git ${receipt.status}: ${receipt.reason}. Retry recorded effect ${receipt.effectId}.`)
}
// The owner intent and its business facts become durable in one batch before materialization.
// A retry reuses that plan and public result, so uploads are not added under another filename.
export function executeInitiativeOwnerOperation(target:RunTarget,operation:OwnerOperation):Promise<{result:Record<string,unknown>;commit:string|null}> {
  return withWorktreeAdmission(target.wt.path,async()=>{
    const initial=await readInitiativeStream(target.ini.dir),events=ownerEvents(initial)
    const pending=events.findLast(event=>event.type==='InitiativeOwnerGitRequested'&&!completed(events,event.plan.effectId))
    if(pending?.type==='InitiativeOwnerGitRequested'&&(pending.operation!==operation.operation||pending.requestHash!==operation.requestHash))throw new HttpError(409,'initiative_git_pending',`Finish recorded effect ${pending.plan.effectId} before another owner operation`)
    if(pending?.type!=='InitiativeOwnerGitRequested')await assertWorktreeAdmission(target.wt.path,{operation:'git'})
    return withInitiativeLock(target.ini.dir,async()=>{
      if(pending?.type==='InitiativeOwnerGitRequested')return finishOwnerEffect(target,pending,true)
      const stream=await readInitiativeStream(target.ini.dir),doc=await readInitiative(target.ini.dir),at=new Date().toISOString()
      const prepared=await operation.prepare(doc,at)
      const domain=decideInitiative(doc,prepared.command,at,stream.events)
      if(prepared.noChange&&!domain.length)return {result:prepared.result,commit:null}
      const virtual=domain.map(event=>({event}) as InitiativeEvent)
      const next=projectInitiative([...stream.events,...virtual])
      const plan=await prepareGitEffect(target.wt.path,await prepared.git(next))
      const requested:Extract<InitiativeOwnerGitEvent,{type:'InitiativeOwnerGitRequested'}>={type:'InitiativeOwnerGitRequested',operation:operation.operation,requestHash:operation.requestHash,result:prepared.result,plan}
      await appendOwner(target,stream,[requested],at,domain)
      return finishOwnerEffect(target,requested,true)
    })
  })
}
export function retryInitiativeOwnerEffect(target:RunTarget,id:string):Promise<{result:Record<string,unknown>;commit:string}> {
  return withWorktreeAdmission(target.wt.path,async()=>{
    const request=ownerEvents(await readInitiativeStream(target.ini.dir)).find(event=>event.type==='InitiativeOwnerGitRequested'&&event.plan.effectId===id)
    if(request?.type!=='InitiativeOwnerGitRequested')throw new HttpError(404,'unknown_effect','No such initiative owner effect')
    return withInitiativeLock(target.ini.dir,()=>finishOwnerEffect(target,request,true))
  })
}
export function reconcileInitiativeOwnerEffects(target:RunTarget):Promise<void> {
  return withWorktreeAdmission(target.wt.path,async()=>{
    const events=ownerEvents(await readInitiativeStream(target.ini.dir))
    for(const request of events)if(request.type==='InitiativeOwnerGitRequested'&&!completed(events,request.plan.effectId))await withInitiativeLock(target.ini.dir,()=>finishOwnerEffect(target,request,false)).then(()=>undefined,error=>{if(!(error instanceof HttpError&&error.code==='initiative_git_pending'))throw error})
  })
}
