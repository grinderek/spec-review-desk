import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChangeView } from './change-view.ts'
import type { WorktreeInfo } from './discovery.ts'
import { FeatureParseError, type FeatureView, parseFeature, type StepView, unclassified } from './gherkin.ts'
import { corpusKey } from './run-messages.ts'

export type CorpusState = 'same' | 'differs' | 'not_in_corpus'
export interface CorpusReport { states: Record<string, CorpusState>; drift: string[]; errors: { file: string; message: string }[] }

const canonStep = (s: StepView) => [s.keyword, s.text, s.table, s.docString]

export async function loadCorpus(worktreePath: string): Promise<{ features: FeatureView[]; errors: { file: string; message: string }[] }> {
  const root = path.join(worktreePath, 'features')
  let files: string[]
  try {
    files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.feature')).sort()
  } catch {
    return { features: [], errors: [] }
  }
  const features: FeatureView[] = []
  const errors: { file: string; message: string }[] = []
  for (const rel of files) {
    const file = `features/${rel.split(path.sep).join('/')}`
    try {
      features.push(parseFeature(await readFile(path.join(worktreePath, file), 'utf8'), file, unclassified))
    } catch (error) {
      if (!(error instanceof FeatureParseError)) throw error
      errors.push({ file, message: error.message })
    }
  }
  return { features, errors }
}

function canonical(features: readonly FeatureView[]): Map<string, string> {
  return new Map(
    features.flatMap((f) =>
      f.scenarios.map((s) => [
        corpusKey(f.file, s.title),
        JSON.stringify({ background: f.background.map(canonStep), steps: s.steps.map(canonStep), examples: s.examples }),
      ]),
    ),
  )
}

export function compareToCorpus(change: readonly FeatureView[], corpus: readonly FeatureView[], approved: boolean): Omit<CorpusReport, 'errors'> {
  const theirs = canonical(corpus)
  const states: Record<string, CorpusState> = {}
  for (const f of change) {
    const ours = canonical([f])
    for (const s of f.scenarios) {
      const key = corpusKey(f.file, s.title)
      const other = theirs.get(key)
      states[s.key] = other === undefined ? 'not_in_corpus' : other === ours.get(key) ? 'same' : 'differs'
    }
  }
  return { states, drift: approved ? Object.keys(states).filter((k) => states[k] === 'differs') : [] }
}

export async function corpusReport(wt: WorktreeInfo, view: ChangeView): Promise<CorpusReport> {
  const corpus = await loadCorpus(wt.path)
  return { ...compareToCorpus(view.features, corpus.features, view.review.approved_at !== null), errors: corpus.errors }
}
