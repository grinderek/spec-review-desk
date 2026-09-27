import { commitFiles, resetStaged } from './git.ts'

// Initiative commits (spec B §4): `docs(openspec): <subject>` + the configured trailer.
export const initiativeCommitMessage = (subject: string, trailer: string): string =>
  `docs(openspec): ${subject.replace(/\s+/g, ' ').trim()}\n${trailer ? `\n${trailer}\n` : ''}`

// Commits exactly `files`; a failed commit leaves nothing staged.
export async function commitPaths(cwd: string, files: readonly string[], message: string): Promise<string> {
  try {
    return await commitFiles(cwd, files, message)
  } catch (error) {
    await resetStaged(cwd, files).catch(() => undefined)
    throw error
  }
}
