export const WORKTREE_EVENTS_FILE = '.spec-review/worktree.events.jsonl'
export const creationBlobRelative = (hash: string): string => `.spec-review/creation-blobs/${hash}`
export const initiativeRelative = (name: string): string => `openspec/initiatives/${name}`
export const worktreeRel = (name: string): string => `.codex/worktrees/${name}`
export const CREATION_WORKTREES_EXCLUDE = '.codex/worktrees/'
