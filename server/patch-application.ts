import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HttpError } from './errors.ts'
import { prepareGitEffect, type GitEffectPlan, type GitEffectFileState } from './git-effect.ts'
import { applyPatch } from './patch.ts'
import type { Patch } from './review-store.ts'

const hash = (content: Buffer): string => createHash('sha256').update(content).digest('hex')
// Preview is disposable. The durable plan contains the complete outputs, never a diff to replay
// against possibly changed files after a crash.
export async function preparePatchApplication(cwd: string, patch: Patch, ref: string, message: string, extraFiles: readonly string[]): Promise<GitEffectPlan> {
  if (patch.files.length > 100) throw new HttpError(422, 'patch_file_unsupported', 'Patch has more than 100 output paths')
  let sourceBytes = 0, outputBytes = 0
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'desk-patch-preview-'))
  const sources = new Map<string, GitEffectFileState | null>()
  try {
    for (const relative of patch.files) {
      if (!relative || path.posix.isAbsolute(relative) || /[\\\0\r\n]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
        throw new HttpError(422, 'patch_path_invalid', `Unsupported patch path ${relative}`)
      }
      const parts = relative.split('/')
      let current = cwd
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part)
        try {
          const info = await lstat(current)
          if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new HttpError(422, 'patch_path_invalid', `Patch path is not a regular file: ${relative}`)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      let handle
      try { handle = await open(path.join(cwd, relative), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        sources.set(relative, null); continue
      }
      try {
        const info = await handle.stat()
        const mode = info.mode & 0o777
        if (!info.isFile() || info.size > 4 * 1024 * 1024 || (info.mode & 0o7000) || (mode !== 0o644 && mode !== 0o755)) throw new HttpError(422, 'patch_file_unsupported', `Unsupported patch file ${relative}`)
        sourceBytes += info.size
        if (sourceBytes > 16 * 1024 * 1024) throw new HttpError(422, 'patch_file_unsupported', 'Patch source files exceed 16 MiB')
        const content = await handle.readFile()
        if (content.length > 4 * 1024 * 1024) throw new HttpError(422, 'patch_file_unsupported', `Patch file exceeds 4 MiB: ${relative}`)
        sources.set(relative, { hash: hash(content), mode })
        const target = path.join(tmp, relative)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
        await chmod(target, mode)
      } finally { await handle.close() }
    }
    await applyPatch(tmp, patch.diff)
    const outputs = []
    for (const relative of patch.files) {
      try {
        const target = path.join(tmp, relative)
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new HttpError(422, 'patch_file_unsupported', `Unsupported preview output ${relative}`)
        outputBytes += info.size
        if (outputBytes > 16 * 1024 * 1024) throw new HttpError(422, 'patch_file_unsupported', 'Patch outputs exceed 16 MiB')
        outputs.push({ path: relative, content: await readFile(target), mode: info.mode & 0o777 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        outputs.push({ path: relative, content: null })
      }
    }
    const plan = await prepareGitEffect(cwd, { purpose: { kind: 'review-patch', ref }, outputs, message, extraFiles })
    for (const file of plan.files) {
      const source = sources.get(file.path)
      if (!source || !file.before ? source !== file.before : source.hash !== file.before.hash || source.mode !== file.before.mode) {
        throw new HttpError(409, 'patch_source_changed', 'Patch source changed while preparing its application. Review the current files and retry.')
      }
    }
    return plan
  } finally { await rm(tmp, { recursive: true, force: true }) }
}
