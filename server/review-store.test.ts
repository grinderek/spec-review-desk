import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addThread, appendMessage, effectiveStatus, emptyReview, moveEntry, orphanKeys, readReview, recordApproval,
  REVIEW_FILE, ReviewFileError, setEntry, setThreadStatus, type Thread, updatePatch, updateReview, writeReview,
} from './review-store.ts'

const dir = () => mkdtemp(path.join(os.tmpdir(), 'sr-review-'))
const KEY = `features/x.feature::It's "quoted": #1 — ünïcode`
const approved = { status: 'approved' as const, text_hash: 'sha256:a', approved_commit: 'abc1234', at: '2026-09-23T10:00:00.000Z' }
const thread: Thread = { id: 't_1', anchor: 'scenario', ref: KEY, status: 'open', messages: [{ role: 'owner', at: '2026-09-23T10:00:00.000Z', text: 'why?', note: null, patch: null }] }

describe('review.yaml IO', () => {
  it('returns an empty review when the file is missing', async () => {
    expect(await readReview(await dir())).toEqual(emptyReview())
  })

  it('round-trips keys with quotes, colons, hashes and non-ASCII', async () => {
    const d = await dir()
    const doc = addThread(setEntry(emptyReview(), 'scenarios', KEY, approved), thread)
    await writeReview(d, doc)
    expect(await readReview(d)).toEqual(doc)
  })

  it('rejects an invalid file with its issues', async () => {
    const d = await dir()
    await writeFile(path.join(d, REVIEW_FILE), 'version: 2\nscenarios: []\n')
    await expect(readReview(d)).rejects.toBeInstanceOf(ReviewFileError)
    await writeFile(path.join(d, REVIEW_FILE), 'version: [unclosed\n')
    await expect(readReview(d)).rejects.toBeInstanceOf(ReviewFileError)
  })

  it('re-reads under the lock, so an external edit between two updates survives', async () => {
    const d = await dir()
    await updateReview(d, (doc) => setEntry(doc, 'scenarios', 'a', approved))
    const external = (await readFile(path.join(d, REVIEW_FILE), 'utf8')).replace('agent_session: null', 'agent_session: external')
    await writeFile(path.join(d, REVIEW_FILE), external)
    const result = await updateReview(d, (doc) => setEntry(doc, 'phrases', 'p', approved))
    expect(result.agent_session).toBe('external')
    expect(Object.keys(result.scenarios)).toEqual(['a'])
  })

  it('serializes concurrent updates of one change', async () => {
    const d = await dir()
    await Promise.all(Array.from({ length: 10 }, (_, i) => updateReview(d, (doc) => setEntry(doc, 'scenarios', `k${i}`, approved))))
    expect(Object.keys((await readReview(d)).scenarios)).toHaveLength(10)
  })
})

describe('effectiveStatus', () => {
  it('is pending without an entry', () => {
    expect(effectiveStatus(undefined, 'sha256:a')).toEqual({ status: 'pending', changedSinceApproval: false, approvedCommit: null })
  })
  it('keeps the status while the hash matches', () => {
    expect(effectiveStatus(approved, 'sha256:a').status).toBe('approved')
    expect(effectiveStatus({ ...approved, status: 'changes_requested' }, 'sha256:a').status).toBe('changes_requested')
  })
  it('falls back to pending, flagged, when the text changed after approval', () => {
    expect(effectiveStatus(approved, 'sha256:b')).toEqual({ status: 'pending', changedSinceApproval: true, approvedCommit: 'abc1234' })
  })
})

describe('pure updates', () => {
  it('never mutates the input document', () => {
    const doc = addThread(emptyReview(), thread)
    const frozen = JSON.stringify(doc)
    appendMessage(doc, 't_1', { role: 'agent', at: 'now', text: 'because', note: null, patch: { diff: 'd', state: 'proposed', commit: null, error: null } })
    setThreadStatus(doc, 't_1', 'resolved')
    setEntry(doc, 'scenarios', 'x', approved)
    recordApproval(doc, 'now', 'abc')
    expect(JSON.stringify(doc)).toBe(frozen)
  })

  it('updates a patch in place of the message', () => {
    const withPatch = appendMessage(addThread(emptyReview(), thread), 't_1', { role: 'agent', at: 'now', text: 'x', note: null, patch: { diff: 'd', state: 'proposed', commit: null, error: null } })
    expect(updatePatch(withPatch, 't_1', 1, { state: 'applied', commit: 'def5678' }).threads[0]!.messages[1]!.patch).toMatchObject({ state: 'applied', commit: 'def5678' })
    expect(() => updatePatch(withPatch, 't_1', 0, { state: 'applied' })).toThrow(/no patch/)
  })

  it('removes, moves and finds orphaned entries', () => {
    const doc = setEntry(setEntry(emptyReview(), 'scenarios', 'old', approved), 'scenarios', 'kept', approved)
    expect(orphanKeys(doc, ['kept', 'new'], [])).toEqual({ scenarios: ['old'], phrases: [] })
    expect(Object.keys(moveEntry(doc, 'scenarios', 'old', 'new').scenarios).sort()).toEqual(['kept', 'new'])
    expect(Object.keys(setEntry(doc, 'scenarios', 'old', null).scenarios)).toEqual(['kept'])
  })
})
