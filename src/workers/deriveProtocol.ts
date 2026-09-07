import type { WorkspaceState } from '@/state/types'
import type { IslandSnapshot } from '@/island/derive'

/**
 * Messages to and from the derivation worker.
 *
 * The whole workspace crosses the wire on every derive. That is deliberate for
 * now: `derive` is a few milliseconds for a thousand tasks, and structured
 * clone of the store is cheap next to the alternative - keeping a replica in
 * the worker and feeding it Immer patches, which is a second source of truth
 * living in a second thread. Phase 8 revisits this if the profile says to.
 */

export interface DeriveRequest {
  type: 'derive'
  /** Echoed back, so a late reply from a superseded request can be dropped. */
  seq: number
  state: WorkspaceState
}

export interface DeriveResponse {
  type: 'snapshot'
  seq: number
  snapshot: IslandSnapshot
  elapsedMs: number
}
