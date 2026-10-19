// One identity for executable contracts, approvals, corpus comparison and execution results.
// Callers supply a feature-relative path, optionally prefixed by exactly one features/ namespace.
export const STABLE_SCENARIO_ID = /^[a-z][a-z0-9-]*$/
export class ContractIdentityError extends Error {}

export interface ContractPathOptions { stripFeaturesNamespace?: boolean }
export function canonicalContractPath(file: string, options: ContractPathOptions = {}): string {
  if (!file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || /[\\\0-\x1f\x7f]/.test(file) || file.includes('::')) {
    throw new ContractIdentityError(`Invalid contract path: ${file}`)
  }
  const relative = options.stripFeaturesNamespace !== false && file.startsWith('features/') ? file.slice('features/'.length) : file
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new ContractIdentityError(`Ambiguous contract path: ${file}`)
  }
  if (!relative.endsWith('.desk.yaml') && !relative.endsWith('.feature')) throw new ContractIdentityError(`Not an executable contract path: ${file}`)
  return relative
}
export function contractKey(file: string, id: string, options: ContractPathOptions = {}): string {
  if (!STABLE_SCENARIO_ID.test(id)) throw new ContractIdentityError(`Invalid scenario id: ${id}`)
  return `${canonicalContractPath(file, options)}::${id}`
}
export function splitContractKey(key: string): { file: string; id: string } {
  const delimiter = key.indexOf('::')
  if (delimiter < 0 || key.indexOf('::', delimiter + 2) >= 0) throw new ContractIdentityError(`Invalid contract key: ${key}`)
  const file = key.slice(0, delimiter), id = key.slice(delimiter + 2)
  if (contractKey(file, id, { stripFeaturesNamespace: false }) !== key) throw new ContractIdentityError(`Contract key is not canonical: ${key}`)
  return { file, id }
}
export const contractFile = (key: string): string => splitContractKey(key).file
export const contractId = (key: string): string => splitContractKey(key).id

export function gherkinScenarioId(tags: readonly string[]): string {
  const ids = tags.filter(tag => tag.startsWith('@id:'))
  if (ids.length !== 1 || !STABLE_SCENARIO_ID.test(ids[0]!.slice(4))) {
    throw new ContractIdentityError('A Gherkin scenario requires exactly one @id:<stable-id> tag')
  }
  return ids[0]!.slice(4)
}
