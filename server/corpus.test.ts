import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareToCorpus, loadCorpus } from './corpus.ts'
import { parseFeature, unclassified } from './gherkin.ts'
import { FEATURE } from './testing/fixtures.ts'
import { makeRepo } from './testing/repo.ts'

const change = [parseFeature(FEATURE, 'features/thread_state.feature', unclassified)]
const PLAIN = "features/thread_state.feature::The founder's reply resolves a waiting thread"
const OUTLINE = 'features/thread_state.feature::A waiting thread is weighted by its age'

async function corpusWith(source: string | null) {
  const { repo } = await makeRepo()
  const file = path.join(repo, 'features/health_score/thread_state.feature')
  await mkdir(path.dirname(file), { recursive: true })
  if (source !== null) await writeFile(file, source)
  else await rm(file, { force: true })
  await writeFile(path.join(repo, 'features/health_score/broken.feature'), 'Feature: a\n  Scenario: s\n    Given x:\n      | a | b |\n      | 1 |\n')
  return loadCorpus(repo)
}

describe('corpus drift', () => {
  it('matches a corpus copy, ignoring comments', async () => {
    const corpus = await corpusWith(FEATURE.replace('# The replied thread is not a candidate', '# A different note'))
    expect(corpus.errors.map((e) => e.file)).toEqual(['features/health_score/broken.feature'])
    expect(compareToCorpus(change, corpus.features, true)).toEqual({ states: { [PLAIN]: 'same', [OUTLINE]: 'same' }, drift: [] })
  })

  it('flags a scenario whose steps or examples differ, as drift only after approval', async () => {
    const corpus = await corpusWith(FEATURE.replace('| 2026-09-18 16:00 | 2     |', '| 2026-09-18 16:00 | 3     |'))
    expect(compareToCorpus(change, corpus.features, true)).toEqual({ states: { [PLAIN]: 'same', [OUTLINE]: 'differs' }, drift: [OUTLINE] })
    expect(compareToCorpus(change, corpus.features, false).drift).toEqual([])
  })

  it('reports scenarios the corpus does not have', async () => {
    const corpus = await corpusWith(null)
    expect(compareToCorpus(change, corpus.features, true).states).toEqual({ [PLAIN]: 'not_in_corpus', [OUTLINE]: 'not_in_corpus' })
  })
})
