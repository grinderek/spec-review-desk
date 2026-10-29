import path from 'node:path'
import { watch } from 'chokidar'
import type { WorktreeInfo } from './discovery.ts'
import type { EventBus } from './events.ts'
import { CHANGE_ROOT, INITIATIVE_ROOT } from './change-package.ts'

export function watchChanges(worktrees: readonly WorktreeInfo[], bus: EventBus): () => Promise<void> {
  const watchers = worktrees.map((wt) => {
    const watcher = watch([path.join(wt.path, CHANGE_ROOT), path.join(wt.path, INITIATIVE_ROOT), path.join(wt.path, 'features')], {
      ignoreInitial: true,
      ignored: (p: string) => p.endsWith('.tmp'),
    })
    let timer: NodeJS.Timeout | null = null
    watcher.on('all', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => bus.publish('files', { worktreeId: wt.id }), 300)
    })
    return watcher
  })
  return async () => {
    await Promise.all(watchers.map((w) => w.close()))
  }
}
