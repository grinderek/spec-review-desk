import { describe, expect, it } from 'vitest'
import { reduceLiveLog } from './live-log.ts'

describe('reduceLiveLog', () => {
  it('appends delta and answer_delta text', () => {
    let text = ''
    text = reduceLiveLog(text, { type: 'event', event: { type: 'delta', text: 'Read' } })
    text = reduceLiveLog(text, { type: 'event', event: { type: 'answer_delta', text: 'ing.' } })
    expect(text).toBe('Reading.')
  })

  it('drops the accumulated text on answer_reset so a re-emitted answer is not shown twice', () => {
    let text = reduceLiveLog('', { type: 'event', event: { type: 'answer_delta', text: 'not this' } })
    text = reduceLiveLog(text, { type: 'event', event: { type: 'answer_reset' } })
    text = reduceLiveLog(text, { type: 'event', event: { type: 'answer_delta', text: 'Stopped before step 3.' } })
    expect(text).toBe('Stopped before step 3.')
  })

  it('ignores non-event messages and unrelated event types', () => {
    const text = reduceLiveLog('so far', { type: 'queued' })
    expect(reduceLiveLog(text, { type: 'event', event: { type: 'started' } })).toBe('so far')
    expect(reduceLiveLog(text, null)).toBe('so far')
  })
})
