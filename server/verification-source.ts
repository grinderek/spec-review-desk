import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { loadCorpus } from './corpus.ts'
import { git } from './git.ts'
import { corpusKey } from './run-messages.ts'

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const File = z.object({ path: z.string(), hash: Hash.nullable(), mode: z.number().int().nullable() })
const Contract = z.object({ key: z.string(), hash: z.string(), rows: z.number().int().positive() })
const Source = z.object({ version: z.literal(1), head: z.string().regex(/^[0-9a-f]{40,64}$/), files: z.array(File), contracts: z.array(Contract), hash: Hash })
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const VerificationSourceSchema = Source.superRefine((source, ctx) => {
  const { hash, ...body } = source
  if (digest(body) !== hash) ctx.addIssue({ code: 'custom', message: 'Verification source manifest hash mismatch' })
  if (new Set(source.files.map(f => f.path)).size !== source.files.length || new Set(source.contracts.map(c => c.key)).size !== source.contracts.length) {
    ctx.addIssue({ code: 'custom', message: 'Verification input identities are not unique' })
  }
})
export type VerificationSource = z.infer<typeof VerificationSourceSchema>

async function inputFile(cwd: string, relative: string): Promise<z.infer<typeof File>> {
  if (path.posix.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe verification input path')
  let handle
  try {
    const parent = path.dirname(path.join(cwd, relative))
    if (await realpath(parent) !== parent) throw new Error(`Verification input parent is a symbolic link: ${relative}`)
    handle = await open(path.join(cwd, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, hash: null, mode: null }
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`Verification input is not a regular file: ${relative}`)
    const hash = createHash('sha256')
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error(`Verification input changed while being read: ${relative}`)
    return { path: relative, hash: hash.digest('hex'), mode: before.mode & 0o777 }
  } finally { await handle.close() }
}

// The manifest identifies the actual working tree, including uncommitted sources. Operational
// execution artifacts cannot change the input version merely by producing their own result.
export async function captureVerificationSource(cwd: string): Promise<VerificationSource> {
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  const listed = (await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  const paths = [...new Set(listed)].filter(file => file !== '.spec-review' && !file.startsWith('.spec-review/')).sort()
  if (paths.length > 100_000) throw new Error('Verification source manifest exceeds 100000 files')
  const files = []
  for (const relative of paths) files.push(await inputFile(cwd, relative))
  const corpus = await loadCorpus(cwd)
  if (corpus.errors.length) throw new Error(`Cannot verify an invalid corpus: ${corpus.errors.map(e => e.message).join('; ')}`)
  const contracts = corpus.features.flatMap(feature => feature.scenarios.map(scenario => ({
    key: corpusKey(feature.file, scenario.title), hash: scenario.hash,
    rows: scenario.examples.reduce((count, example) => count + example.rows.length, 0) || 1,
  }))).sort((a, b) => a.key.localeCompare(b.key, 'en'))
  if (await git(cwd, ['rev-parse', 'HEAD']).then(value => value.trim()) !== head) throw new Error('HEAD changed while capturing verification inputs')
  const body = { version: 1 as const, head, files, contracts }
  return VerificationSourceSchema.parse({ ...body, hash: digest(body) })
}
