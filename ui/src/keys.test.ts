import { describe, expect, it } from 'vitest'
import { corpusKey, cssId, defaultSummary, stripDiff } from './keys.ts'

describe('ui helpers', () => {
  it('builds corpus keys and DOM-safe ids', () => {
    expect(corpusKey('features/thread_state.feature', 'A title')).toBe('thread_state.feature::A title')
    expect(cssId("features/x.feature::It's #1")).toBe('features_x_feature__It_s__1')
  })

  it('strips diff blocks from agent text', () => {
    const diff = '--- a/o/x.feature\n+++ b/o/x.feature\n@@ -1 +1 @@\n-a\n+b\n'
    expect(stripDiff(`Answer.\n\n\`\`\`diff\n${diff}\`\`\`\n`)).toBe('Answer.')
    expect(defaultSummary(`\n\`\`\`diff\n${diff}\`\`\`\nRows weigh by age.\nMore.`)).toBe('Rows weigh by age.')
  })
})
