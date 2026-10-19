import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

// Native namespaces also occur in standalone author output, outside a Git worktree.
// Missing directories are allowed during discovery; existing ancestors must be regular.
export async function regularDirectoryPath(directory: string): Promise<boolean> {
  const absolute = path.resolve(directory)
  const root = path.parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = await lstat(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Native directory path is not a regular directory: ${current}`)
  }
  return true
}

export async function nativeScopeDirectories(root: string, validName: (name: string) => boolean): Promise<string[]> {
  if (!await regularDirectoryPath(root)) return []
  const names: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!validName(entry.name)) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Native scope is not a regular directory: ${path.join(root, entry.name)}`)
    names.push(entry.name)
  }
  return names.sort()
}
