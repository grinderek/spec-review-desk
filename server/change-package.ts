import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { type Catalog, emptyCatalog, makeClassifier, parseCatalog } from './catalog.ts'
import { canonicalContractPath, contractKey, STABLE_SCENARIO_ID } from './contract-identity.ts'
import { deskFeature, parseDeskDsl, type DeskScenario } from './desk-dsl.ts'
import { type Classify, type FeatureView, type ScenarioView, parseFeature, unclassified } from './gherkin.ts'
import { CHANGE_NAME, INITIATIVE_NAME } from './initiative-model.ts'
import { regularDirectoryPath } from './native-path.ts'

export const CHANGE_ROOT = 'desk/changes'
export const CHANGE_ARCHIVE_ROOT = `${CHANGE_ROOT}/archive`
export const INITIATIVE_ROOT = 'desk/initiatives'
export const CHANGE_FILE = 'change.yaml'
export const CONTRACT_ROOT = 'features'
export const ChangeMetadataSchema = z.object({
  version: z.literal(1), kind: z.literal('behavior-driven'),
  title: z.string().refine(value => value.trim().length > 0, 'title must not be blank').optional(),
  created: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
}).strict()
export type ChangeMetadata = z.infer<typeof ChangeMetadataSchema>

const packageName = (name: string, kind: 'change' | 'initiative'): string => {
  if (!(kind === 'change' ? CHANGE_NAME : INITIATIVE_NAME).test(name) || (kind === 'change' && name === 'archive')) throw new Error(`Invalid native ${kind} name: ${name}`)
  return name
}
export const changeDir = (worktree: string, name: string): string => path.join(worktree, CHANGE_ROOT, packageName(name, 'change'))
export const archiveChangeDir = (worktree: string, name: string): string => path.join(worktree, CHANGE_ARCHIVE_ROOT, packageName(name, 'change'))
export const initiativeDir = (worktree: string, name: string): string => path.join(worktree, INITIATIVE_ROOT, packageName(name, 'initiative'))

export interface PackageProblem {
  code: 'metadata' | 'path' | 'duplicate-path' | 'contract' | 'scenario-id' | 'duplicate-id' | 'shape' | 'catalog' | 'missing-contracts' | 'read'
  file: string
  message: string
  scenarioId?: string
  line?: number
}
export class ChangePackageError extends Error {
  constructor(readonly problems: readonly PackageProblem[]) {
    super(problems.map(problem => `${problem.file}: ${problem.message}`).join('; '))
  }
}
export interface ContractSource { file: string; source: string }
export interface NativeContract {
  key: string
  id: string
  file: string
  title: string
  hash: string
  // Exact bytes of the complete source file, in addition to the parser's semantic scenario hash.
  sourceHash: string
  scenario: ScenarioView
  yaml?: DeskScenario
}
export interface ParsedContractFile extends ContractSource {
  format: 'desk-dsl' | 'gherkin'
  sourceHash: string
  feature: FeatureView
  contracts: NativeContract[]
}
export interface ChangePackage {
  metadata: ChangeMetadata | null
  features: FeatureView[]
  files: ParsedContractFile[]
  contracts: NativeContract[]
  problems: PackageProblem[]
  valid: boolean
}
export interface PackageOptions { approvedCatalog?: Catalog; classify?: Classify }
const sourceHash = (source: string): string => `sha256:${createHash('sha256').update(source).digest('hex')}`
const problemText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const safeRelative = (file: string): boolean => Boolean(file) && !file.startsWith('/') && !/^[A-Za-z]:/.test(file)
  && !/[\\\0-\x1f\x7f]/.test(file) && !file.includes('::')
  && file.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

export function parseChangeMetadata(source: string, file = CHANGE_FILE): ChangeMetadata {
  try {
    const yaml = parseDocument(source, { uniqueKeys: true })
    if (yaml.errors.length) throw yaml.errors[0]
    return ChangeMetadataSchema.parse(yaml.toJS({ maxAliasCount: 0 }))
  } catch (error) { throw new ChangePackageError([{ code: 'metadata', file, message: problemText(error) }]) }
}

export function parseNativeContract(source: string, file: string, classify: Classify = unclassified): ParsedContractFile {
  const problems: PackageProblem[] = []
  let relative: string
  try { relative = canonicalContractPath(file) }
  catch (error) { throw new ChangePackageError([{ code: 'path', file, message: problemText(error) }]) }
  // Views retain the source namespace for file links. Every scenario key uses the common identity.
  const viewFile = `${CONTRACT_ROOT}/${relative}`
  const format = relative.endsWith('.desk.yaml') ? 'desk-dsl' : 'gherkin'
  let feature: FeatureView
  let yaml: ReturnType<typeof parseDeskDsl> | undefined
  try {
    if (format === 'desk-dsl') { yaml = parseDeskDsl(source, viewFile); feature = deskFeature(source, viewFile) }
    else feature = parseFeature(source, viewFile, classify)
  } catch (error) { throw new ChangePackageError([{ code: 'contract', file: viewFile, message: problemText(error) }]) }
  const ids = new Set<string>()
  const hash = sourceHash(source)
  const contracts: NativeContract[] = []
  for (const [index, scenario] of feature.scenarios.entries()) {
    const tags = scenario.tags.filter(tag => tag.startsWith('@id:'))
    const id = yaml?.scenarios[index]?.id ?? (tags.length === 1 ? tags[0]!.slice('@id:'.length) : '')
    if (!yaml && tags.length !== 1) {
      problems.push({ code: 'scenario-id', file: viewFile, line: scenario.line, message: 'A native Gherkin scenario requires exactly one @id:<stable-id> tag' }); continue
    }
    if (!STABLE_SCENARIO_ID.test(id)) {
      problems.push({ code: 'scenario-id', file: viewFile, line: scenario.line, message: `Invalid stable scenario id: ${id}` }); continue
    }
    if (ids.has(id)) { problems.push({ code: 'duplicate-id', file: viewFile, scenarioId: id, line: scenario.line, message: `Duplicate scenario id: ${id}` }); continue }
    ids.add(id)
    scenario.key = contractKey(viewFile, id)
    contracts.push({ key: scenario.key, id, file: viewFile, title: scenario.title, hash: scenario.hash, sourceHash: hash, scenario, ...(yaml ? { yaml: yaml.scenarios[index]! } : {}) })
  }
  if (problems.length) throw new ChangePackageError(problems)
  return { file: viewFile, source, format, sourceHash: hash, feature, contracts }
}

// Author output and disk loading share this structural validator. Optional prose is not a gate.
export function validateChangePackageSources(sources: readonly ContractSource[] | Record<string, string>, options: PackageOptions = {}): ChangePackage {
  const entries = Array.isArray(sources) ? sources : Object.entries(sources).map(([file, source]) => ({ file, source }))
  const problems: PackageProblem[] = []
  const unique = new Map<string, ContractSource>()
  for (const entry of entries) {
    if (!safeRelative(entry.file)) { problems.push({ code: 'path', file: entry.file, message: 'Package paths must be unambiguous relative paths with directory parents' }); continue }
    const spelling = entry.file.toLowerCase()
    if (unique.has(spelling)) { problems.push({ code: 'duplicate-path', file: entry.file, message: `Duplicate or case-ambiguous package path: ${unique.get(spelling)!.file}` }); continue }
    unique.set(spelling, entry)
  }
  const directories = new Map<string, string>()
  for (const entry of unique.values()) {
    const parts = entry.file.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/'), folded = directory.toLowerCase()
      if (unique.has(folded)) problems.push({ code: 'path', file: entry.file, message: `A file is also used as a directory: ${directory}` })
      const spelling = directories.get(folded)
      if (spelling && spelling !== directory) problems.push({ code: 'duplicate-path', file: entry.file, message: `Case-ambiguous directory paths: ${spelling} and ${directory}` })
      else directories.set(folded, directory)
    }
  }
  const lookup = (file: string): ContractSource | undefined => [...unique.values()].find(entry => entry.file === file)
  let metadata: ChangeMetadata | null = null
  const declaration = lookup(CHANGE_FILE)
  if (!declaration) problems.push({ code: 'metadata', file: CHANGE_FILE, message: 'Native change metadata is required' })
  else { try { metadata = parseChangeMetadata(declaration.source) } catch (error) { problems.push(...(error as ChangePackageError).problems) } }
  let proposed = emptyCatalog()
  const catalog = lookup(`${CONTRACT_ROOT}/NEW_STEPS.md`)
  if (catalog) {
    proposed = parseCatalog(catalog.source)
    for (const phrase of proposed.phrases) if (phrase.compileError) problems.push({ code: 'catalog', file: catalog.file, message: phrase.compileError })
  }
  const classify = options.classify ?? makeClassifier(options.approvedCatalog ?? emptyCatalog(), proposed)
  const files: ParsedContractFile[] = []
  const keys = new Set<string>()
  for (const entry of [...unique.values()].sort((a, b) => a.file.localeCompare(b.file, 'en'))) {
    if (!entry.file.endsWith('.feature') && !entry.file.endsWith('.desk.yaml')) continue
    if (!entry.file.startsWith(`${CONTRACT_ROOT}/`)) { problems.push({ code: 'path', file: entry.file, message: 'Executable contracts must be under features/' }); continue }
    try {
      const parsed = parseNativeContract(entry.source, entry.file, classify)
      files.push(parsed)
      for (const contract of parsed.contracts) {
        if (keys.has(contract.key)) problems.push({ code: 'duplicate-id', file: entry.file, scenarioId: contract.id, message: `Duplicate contract key: ${contract.key}` })
        keys.add(contract.key)
        for (const warning of contract.scenario.shape.warnings) problems.push({ code: 'shape', file: entry.file, scenarioId: contract.id, line: contract.scenario.line, message: warning })
      }
    } catch (error) {
      if (!(error instanceof ChangePackageError)) throw error
      problems.push(...error.problems)
    }
  }
  const contracts = files.flatMap(file => file.contracts)
  if (!contracts.length) problems.push({ code: 'missing-contracts', file: CONTRACT_ROOT, message: 'At least one executable contract is required' })
  return { metadata, features: files.map(file => file.feature), files, contracts, problems, valid: problems.length === 0 }
}

export async function loadChangePackage(dir: string, options: PackageOptions = {}): Promise<ChangePackage> {
  const sources: ContractSource[] = []
  const problems: PackageProblem[] = []
  try {
    if (!await regularDirectoryPath(dir)) throw new Error('Package root does not exist')
  } catch (error) {
    const result = validateChangePackageSources([], options)
    result.problems.unshift({ code: 'read', file: dir, message: problemText(error) }); result.valid = false
    return result
  }
  const read = async (file: string): Promise<void> => {
    let handle
    try {
      const target = path.join(dir, file)
      if (!await regularDirectoryPath(path.dirname(target))) throw new Error('Package source parent does not exist')
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat()
      if (!before.isFile()) throw new Error('Package source must be a regular file')
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error('Package source changed while being read')
      sources.push({ file, source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ code: 'read', file, message: problemText(error) }) }
    finally { await handle?.close() }
  }
  await read(CHANGE_FILE)
  const visit = async (relative: string): Promise<void> => {
    let names: string[]
    try {
      const info = await lstat(path.join(dir, relative))
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Contract directories may not be symlinks or special files')
      names = (await readdir(path.join(dir, relative))).sort()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push({ code: 'read', file: relative, message: problemText(error) }); return }
    for (const name of names) {
      const file = `${relative}/${name}`
      try {
        const info = await lstat(path.join(dir, file))
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) { problems.push({ code: 'path', file, message: 'Only regular contract files and directories are allowed' }); continue }
        if (info.isDirectory()) await visit(file)
        else if (file.endsWith('.feature') || file.endsWith('.desk.yaml') || file === `${CONTRACT_ROOT}/NEW_STEPS.md`) await read(file)
      } catch (error) { problems.push({ code: 'read', file, message: problemText(error) }) }
    }
  }
  await visit(CONTRACT_ROOT)
  const result = validateChangePackageSources(sources, options)
  result.problems.unshift(...problems); result.valid = result.problems.length === 0
  return result
}
