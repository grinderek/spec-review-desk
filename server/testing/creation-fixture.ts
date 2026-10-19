import { chmod, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from '../config.ts'
import { worktreeId } from '../discovery.ts'
import { withWorktreeAdmission } from '../execution-admission.ts'
import { executeGitEffect } from '../git-effect.ts'
import { git } from '../git.ts'
import { requestInitiativeCreation, executeInitiativeCreation, type CreateInput } from '../initiative-create.ts'
import { prepareCreationGit, proveCreationWorktree, provisionCreationWorktree, withCreationLease } from '../worktree-creation.ts'
import { readWorktreeStream, recordWorktreeEvents } from '../worktree-events.ts'

export async function prepareCreationFixture(config: Config, phase: string, data: Record<string, any>) {
  const anchor = config.repos[0]!.path
  const input: CreateInput = { repo: config.repos[0]!.name, name: data.name ?? 'new-feature', title: 'New feature', brief: 'Describe the intended behavior.',
    where: data.where === 'new' || phase === 'foreign' ? { kind: 'new', base: 'main' } : { kind: 'existing', worktreeId: worktreeId(anchor) }, files: [], fromRepo: data.fromRepo ?? [] }
  let state = await requestInitiativeCreation(config, input, new Date().toISOString())
  if (phase === 'foreign') await git(anchor, ['branch', state.request.branch!.slice('refs/heads/'.length), state.request.base])
  if (phase === 'provisioned') await withCreationLease(anchor, () => provisionCreationWorktree(state.request))
  if (phase === 'completed') await executeInitiativeCreation(config, input.repo, state.request.id)
  if (phase === 'pending') {
    const hook = path.join(state.request.anchor.commonDir, 'hooks/pre-commit')
    await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755)
    try { await executeInitiativeCreation(config, input.repo, state.request.id); throw new Error('The configured commit rejection did not occur') }
    catch (error) { if (!String(error).includes('No effect commit') && !String(error).includes('planned files are materialized')) throw error }
    finally { await rm(hook, { force: true }) }
  }
  if (phase === 'receipt') await withCreationLease(anchor, () => withWorktreeAdmission(state.request.targetPath, async () => {
    await provisionCreationWorktree(state.request)
    const identity = await proveCreationWorktree(state)
    await recordWorktreeEvents(anchor, () => [{ type: 'InitiativeWorktreeConfirmed', creationId: state.request.id, identity }])
    state = (await readWorktreeStream(anchor)).creations.find(item => item.request.id === state.request.id)!
    const plan = await prepareCreationGit(state)
    await recordWorktreeEvents(anchor, () => [{ type: 'InitiativeCreationGitRequested', creationId: state.request.id, plan }])
    const receipt = await executeGitEffect(state.request.targetPath, plan)
    if (receipt.status !== 'completed') throw new Error('Could not prepare the missing creation acknowledgment')
  }))
  state = (await readWorktreeStream(anchor)).creations.find(item => item.request.id === state.request.id)!
  return { input, state }
}
