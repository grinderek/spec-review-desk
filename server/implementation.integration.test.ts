import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DeskWorld } from './testing/desk-world.ts'

let world: DeskWorld
beforeEach(async () => {
  world = await DeskWorld.create()
  await world.given('ScenarioDiscovered', {})
  await world.given('InitiativeOpened', {})
  await world.given('PlanDrafted', { slices: [{ title: 'Engine', scope: 'Engine.', depends_on: [] }] })
  await world.given('PlanApproved', {})
  await world.given('ApprovedSliceProposed', {})
  await world.given('ApplyReplyPrepared', {})
  expect((await world.command('StartApply', {})).status).toBe(202)
  expect((await world.read(String(world.vars.initiative))).body.statuses.s1).toBe('applied')
})
afterEach(async () => { await world?.close() })

// File corruption belongs at the disk/API boundary, not in the owner contract corpus.
it.each(['missing contract', 'malformed approved feature', 'malformed implemented feature'])('does not keep a slice applied after %s', async (kind) => {
  const change = path.join(world.repo, 'openspec/changes/slice-contract/features')
  if (kind === 'missing contract') await rm(path.join(change, 'subject.desk.yaml'))
  else {
    const dir = kind === 'malformed approved feature' ? change : path.join(world.repo, 'features')
    await writeFile(path.join(dir, 'broken.desk.yaml'), 'version: [unclosed')
  }
  const result = await world.read(String(world.vars.initiative))
  expect(result.status).toBe(200)
  expect(result.body.statuses.s1).toBe('approved')
})
