import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contractKey } from './contract-identity.ts'
import { contractHash, type DeskScenario } from './desk-dsl.ts'
import type { DeskWorld } from './testing/desk-world.ts'

export type ContractWorld = Pick<DeskWorld, 'vars' | 'resolve' | 'given' | 'ready' | 'events' | 'command' | 'read' | 'close'>
export interface ContractExecution {
  id: string
  key: string
  file: string
  scenarioId: string
  title: string
  contractHash: string
  row: number | null
  rows: number | null
  parameters: Record<string, unknown>
  given: { name: string; input: unknown; completed: boolean }[]
  command: { name: string; input: unknown } | null
  response: unknown
  events: unknown[] | null
  historyBefore: unknown[] | null
  historyAfterReads: unknown[] | null
  reads: { path: string; response: unknown; error: string | null }[]
  bindings: Record<string, string>
  status: 'passed' | 'failed'
  error: { phase: string; message: string } | null
  cleanupError: string | null
  startedAt: string
  finishedAt: string
}
export function assertSubset(expected: unknown, actual: unknown, field = 'response'): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${field}: expected array`)
    assert.equal(actual.length, expected.length, `${field}: array length`)
    expected.forEach((value, i) => assertSubset(value, actual[i], `${field}[${i}]`))
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${field}: expected object`)
    for (const [key, value] of Object.entries(expected)) assertSubset(value, (actual as Record<string, unknown>)[key], `${field}.${key}`)
  } else assert.deepEqual(actual, expected, field)
}
function payload(event: Record<string, any>): unknown {
  if ('entry' in event) return { key: event.key, hash: event.entry.text_hash, commit: event.entry.approved_commit, at: event.entry.at, ...('thread' in event && event.thread ? { thread: event.thread } : {}) }
  if (event.type === 'ChangeApprovalRecorded') return { at: event.at, commit: event.commit }
  const { version, stream, sequence, id, command, at, origin, type, ...data } = event
  return data
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

// One execution creates both the verdict and diagnostic record. Rendering never calls a
// Given/When/read again, and cleanup is attempted after preparation or command failures.
export async function executeContractCase(input: {
  file: string; scenario: DeskScenario; row: number; parameters: Record<string, unknown>
  createWorld: () => Promise<ContractWorld>
}): Promise<ContractExecution> {
  const { file, scenario, row, parameters } = input
  const record: ContractExecution = {
    id: randomUUID(), key: contractKey(file, scenario.id), file, scenarioId: scenario.id, title: scenario.scenario,
    contractHash: contractHash(scenario), row: scenario.cases ? row : null, rows: scenario.cases?.length ?? null,
    parameters: structuredClone(parameters), given: [], command: null, response: null, events: null, historyBefore: null, historyAfterReads: null, reads: [], bindings: {},
    status: 'failed', error: null, cleanupError: null, startedAt: new Date().toISOString(), finishedAt: '',
  }
  let world: ContractWorld | undefined, before: Awaited<ReturnType<ContractWorld['events']>> | undefined
  let phase = 'prepare'
  try {
    world = await input.createWorld()
    Object.assign(world.vars, parameters)
    phase = 'given'
    for (const fact of scenario.given) {
      const [name, data] = Object.entries(world.resolve(fact))[0]!
      const prepared = { name, input: structuredClone(data), completed: false }
      record.given.push(prepared)
      await world.given(name, data as Record<string, any>)
      prepared.completed = true
    }
    phase = 'ready'
    await world.ready()
    before = structuredClone(await world.events(scenario.then.stream))
    record.historyBefore = structuredClone(before)
    phase = 'when'
    const [name, data] = Object.entries(world.resolve(scenario.when))[0]!
    record.command = { name, input: structuredClone(data) }
    record.response = structuredClone(await world.command(name, data as Record<string, any>))
    phase = 'events'
    record.events = structuredClone((await world.events(scenario.then.stream)).slice(before.length))
    phase = 'then'
    for (const [name, selector] of Object.entries(scenario.then.bind ?? {})) {
      const value = selector.split('.').reduce<any>((object, key) => object?.[key], { response: record.response })
      assert.ok(typeof value === 'string' && value.length > 0, `${selector}: expected a generated non-empty string`)
      if (name in world.vars) assert.equal(world.vars[name], value, `binding $${name} changed`)
      world.vars[name] = value; record.bindings[name] = value
    }
    assertSubset(world.resolve(scenario.then.response), record.response)
    assert.equal(record.events.length, scenario.then.events.length, 'events: exact number appended')
    scenario.then.events.forEach((fact, index) => {
      const [name, fields] = Object.entries(world!.resolve(fact))[0]!
      const event = record.events![index] as Record<string, unknown>
      assert.equal(event.type, name, `events[${index}].type`)
      assertSubset(fields, payload(event), `events[${index}]`)
    })
    phase = 'reads'
    for (const [index, observation] of (scenario.then.reads ?? []).entries()) {
      const url = String(world.resolve(observation.path))
      const observationRecord = { path: url, response: null as unknown, error: null as string | null }
      record.reads.push(observationRecord)
      let response: unknown
      try { response = structuredClone(await world.read(url)); observationRecord.response = response }
      catch (error) { observationRecord.error = message(error); throw error }
      assertSubset(world.resolve(observation.response), response, `reads[${index}]`)
    }
    record.historyAfterReads = structuredClone(await world.events(scenario.then.stream))
    assert.deepEqual(record.historyAfterReads, [...before, ...record.events], 'Then reads appended events')
    record.status = 'passed'
  } catch (error) {
    record.error = { phase, message: message(error) }
    if (world && before && record.events === null) {
      try { record.events = structuredClone((await world.events(scenario.then.stream)).slice(before.length)) } catch { /* Preserve the original command error. */ }
    }
  } finally {
    if (world) {
      if (before && record.historyAfterReads === null) {
        try { record.historyAfterReads = structuredClone(await world.events(scenario.then.stream)) } catch { /* Preserve the execution failure. */ }
      }
      try { await world.close() } catch (error) {
        record.cleanupError = message(error); record.status = 'failed'
        record.error ??= { phase: 'cleanup', message: record.cleanupError }
      }
    }
    record.finishedAt = new Date().toISOString()
  }
  return record
}
