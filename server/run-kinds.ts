import { finishAuthor } from './author-run.ts'
import { finishPlanner } from './planner-run.ts'
import type { Finishers } from './run-service.ts'

// What each kind of run does with its validated reply.
export const FINISHERS: Finishers = {
  planner: finishPlanner,
  author: finishAuthor,
}
