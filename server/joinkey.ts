export interface JoinKeyReport {
  ok: boolean
  missingInFeatures: string[]
  missingInSpecs: string[]
  duplicateTitles: string[]
}

const SCENARIO_HEADING = /^####\s+Scenario:\s*(.+?)\s*$/

export function specTitles(markdown: string): string[] {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = SCENARIO_HEADING.exec(line)
    return match ? [match[1]!] : []
  })
}

const duplicates = (titles: readonly string[]): string[] => titles.filter((t, i) => titles.indexOf(t) !== i)

export function checkJoinKey(spec: readonly string[], features: readonly string[]): JoinKeyReport {
  const specSet = new Set(spec)
  const featureSet = new Set(features)
  const missingInFeatures = [...specSet].filter((t) => !featureSet.has(t))
  const missingInSpecs = [...featureSet].filter((t) => !specSet.has(t))
  const duplicateTitles = [...new Set([...duplicates(spec), ...duplicates(features)])]
  return {
    ok: missingInFeatures.length === 0 && missingInSpecs.length === 0 && duplicateTitles.length === 0,
    missingInFeatures,
    missingInSpecs,
    duplicateTitles,
  }
}
