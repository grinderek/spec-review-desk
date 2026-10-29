import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parse } from 'yaml'
import type { Config } from './config.ts'
import { HttpError } from './errors.ts'
import { git } from './git.ts'
import { readInitiativeBlob } from './initiative-events.ts'
import { ExistingProcessSchema, type InitiativeDoc } from './initiative-model.ts'
import type { IncomingFile } from './inputs.ts'
import { findSecrets } from './secret-scan.ts'

export type ExistingProcess = z.infer<typeof ExistingProcessSchema>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const File = z.object({ path: z.string(), content: z.string(), hash: z.string(), lines: z.number().int().positive() })
const Snapshot = z.object({ version: z.literal(1), product: z.string(), sources: z.array(z.object({ repo: z.string(), title: z.string(), head: z.string(), files: z.array(File), excluded: z.number() })) })
export type ImplementationSnapshot = z.infer<typeof Snapshot>
const readable = (file: string) => /\.(?:[cm]?[jt]sx?|rb|py|cpp|cc|c|h|hpp|sql|sh|ya?ml|json|md|feature|go|rs|java|kt|cs|vue|svelte|html|css|scss|proto|toml)$/i.test(file) || /(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|Gemfile|Rakefile|CMakeLists\.txt|Makefile)$/.test(file)
const excluded = (file: string) => file.split('/').some(p => p.startsWith('.') || ['node_modules','vendor','dist','build','coverage','blobs','inputs'].includes(p)) || /(?:lock(?:\.json)?|\.lock|\.pem|\.key|credentials\.[^.]+)$/i.test(file) || /(?:^|\/)(?:secrets|credentials)(?:\/|\.)/i.test(file)

// Freeze committed code as an immutable initiative input. No application checkout is mounted.
export async function captureImplementation(config: Config, productName: string, anchorRepo: string, selected: string[]): Promise<IncomingFile> {
  const product = config.products?.find(p => p.name === productName)
  if (!product) throw new HttpError(422, 'unknown_product', 'Выберите подключенный продукт.')
  const members = new Map(product.components.flatMap(c => c.repo ? [[c.repo, c] as const] : []))
  if (!members.has(anchorRepo) || !selected.length || new Set(selected).size !== selected.length || selected.some(repo => !members.has(repo))) throw new HttpError(422, 'invalid_process_scope', 'Выберите репозиторий правил и компоненты выбранного продукта.')
  const snapshot: ImplementationSnapshot = { version: 1, product: productName, sources: [] }
  let total = 0
  for (const repoName of selected) {
    const component = members.get(repoName)!, cwd = component.path
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const { realpath } = await import('node:fs/promises')
    if (await realpath(root) !== await realpath(cwd)) throw new HttpError(422, 'invalid_process_source', 'Компонент должен быть корнем Git-репозитория.')
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    const entries = (await git(cwd, ['ls-tree', '-rlz', '--full-tree', head])).split('\0').filter(Boolean)
    const candidates = entries.flatMap(entry => {
      const match = /^(100644|100755) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(entry)
      return match && Number(match[3]) <= 128 * 1024 && readable(match[4]!) && !excluded(match[4]!) && !match[4]!.includes('\\') && !match[4]!.split('/').some(p => p === '..') ? [{ id: match[2]!, file: match[4]! }] : []
    })
    if (candidates.length > 2500) throw new HttpError(422, 'process_scope_too_large', 'Сузьте состав исследования: в одном компоненте более 2500 исходных файлов.')
    // Read one bounded batch for the complete component.
    const bytes = await readBlobs(cwd, candidates.map(c => c.id))
    const source: ImplementationSnapshot['sources'][number] = { repo: repoName, title: component.title, head, files: [], excluded: entries.length - candidates.length }
    for (let i = 0; i < candidates.length; i++) {
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes[i]) } catch { source.excluded++; continue }
      if (content.includes('\0') || findSecrets(content, null).length || /-----BEGIN [\w ]*PRIVATE KEY-----/.test(content)) { source.excluded++; continue }
      total += Buffer.byteLength(content)
      if (total > 12 * 1024 * 1024) throw new HttpError(422, 'process_scope_too_large', 'Сузьте состав исследования: снимок исходников превышает 12 МБ.')
      source.files.push({ path: candidates[i]!.file, content, hash: hash(content), lines: content.split('\n').length })
    }
    if (!source.files.length) throw new HttpError(422, 'empty_process_source', `В компоненте ${repoName} не найдено доступных текстовых исходников.`)
    snapshot.sources.push(source)
  }
  return { name: 'implementation-snapshot.json', bytes: Buffer.from(JSON.stringify(snapshot)), source: { kind: 'implementation', product: productName } }
}

async function readBlobs(cwd: string, ids: string[]): Promise<Buffer[]> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe','pipe','pipe'] })
    const chunks: Buffer[] = []; let size = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 20 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk) })
    child.stderr.resume(); child.stdin.on('error', () => undefined)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new HttpError(422, 'process_source_unreadable', 'Не удалось прочитать снимок исходников. Сузьте состав исследования.')); return }
      try {
        const data = Buffer.concat(chunks), files: Buffer[] = []; let at = 0
        for (const id of ids) {
          const end = data.indexOf(10, at), header = data.subarray(at, end).toString()
          const match = /^([0-9a-f]+) blob (\d+)$/.exec(header)
          if (!match || match[1] !== id) throw new Error('Invalid Git blob response')
          const length = Number(match[2]); at = end + 1
          files.push(data.subarray(at, at + length)); at += length + 1
        }
        resolve(files)
      } catch (error) { reject(error) }
    })
    child.stdin.end(ids.join('\n') + (ids.length ? '\n' : ''))
  })
}

export async function readImplementation(dir: string, doc: InitiativeDoc): Promise<ImplementationSnapshot> {
  const input = doc.inputs.find(i => i.file === doc.existingProcess?.snapshot && i.source.kind === 'implementation' && !i.draft)
  if (!doc.existingProcess || !input) throw new HttpError(404, 'no_implementation', 'В инициативе нет снимка реализации.')
  const snapshot = Snapshot.parse(JSON.parse((await readInitiativeBlob(dir, input.blob)).toString('utf8')))
  if (snapshot.product !== doc.existingProcess.product) throw new Error('Implementation product mismatch')
  return snapshot
}

export function implementationUrl(wt: string, name: string, repo: string, file: string, line = 1): string {
  return `/api/initiatives/${wt}/${encodeURIComponent(name)}/implementation/source?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}&line=${line}#L${line}`
}

// Every proposed rule needs evidence pointing into the exact captured file, never a guessed URL.
export async function implementationEvidence(dir: string, doc: InitiativeDoc, wt: string, keys: string[], outputs: { path: string; content: string; mode: number }[], change: string): Promise<typeof outputs> {
  if (!doc.existingProcess) return outputs
  const metadata = outputs.find(f => f.path === `desk/changes/${change}/implementation-references.yaml`)
  if (!metadata) throw new Error('Подготовьте implementation-references.yaml со ссылками на реализацию каждого правила.')
  const References = z.object({ version: z.literal(1), sources: z.array(z.object({ rule: z.string(), repo: z.string(), path: z.string(), line: z.number().int().positive(), end_line: z.number().int().positive().optional() }).strict()).min(1).max(200) }).strict()
  const refs = References.parse(parse(metadata.content)), snapshot = await readImplementation(dir, doc)
  const lines = ['## Источники реализации', '', 'Наблюдения по зафиксированному коду. Ожидаемое поведение требует согласования владельцем.', '']
  for (const ref of refs.sources) {
    const source = snapshot.sources.find(s => s.repo === ref.repo), file = source?.files.find(f => f.path === ref.path)
    if (!keys.includes(ref.rule) || !source || !file || ref.line > file.lines || (ref.end_line !== undefined && (ref.end_line < ref.line || ref.end_line > file.lines))) throw new Error(`Недостоверная ссылка на реализацию: ${ref.rule} / ${ref.repo} / ${ref.path}`)
    lines.push(`- ${ref.rule}: [${ref.repo}: ${ref.path}:${ref.line}](${implementationUrl(wt, doc.name, ref.repo, ref.path, ref.line)}) · commit ${source.head}`)
  }
  if (keys.some(key => !refs.sources.some(ref => ref.rule === key))) throw new Error('Для каждого исполняемого правила нужна ссылка на реализацию.')
  const target = `desk/changes/${change}/proposal.md`, proposal = outputs.find(o => o.path === target)
  return [...outputs.filter(o => o.path !== target), { path: target, content: `${proposal?.content ?? ''}\n\n${lines.join('\n')}\n`, mode: 0o644 }]
}

export function sourceHtml(source: ImplementationSnapshot['sources'][number], file: ImplementationSnapshot['sources'][number]['files'][number], line: number): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escape(file.path)}</title><style>body{background:#171b18;color:#e6eee8;font:14px monospace;margin:24px}p{overflow-wrap:anywhere}.line{display:block;white-space:pre-wrap}.line:target{background:#425d39}a{color:#98b7ed}code{line-height:1.5}</style><h1>${escape(source.title)}</h1><p>${escape(file.path)} · commit ${escape(source.head)}</p><p>Снимок кода, использованный при подготовке правил. SHA-256: ${file.hash}</p><code>${file.content.split('\n').map((s,i) => `<span class="line" id="L${i+1}"><a href="#L${i+1}">${i+1}</a> ${escape(s)}</span>`).join('')}</code><p>Выбрана строка ${line}.</p></html>`
}
