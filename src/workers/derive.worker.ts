/// <reference lib="webworker" />
import { derive } from '@/island/derive'
import type { DeriveRequest, DeriveResponse } from './deriveProtocol'

/**
 * Derivation, off the main thread.
 *
 * Section 11 requires this to be pure, side-effect free and on a worker. The
 * purity is what makes the worker safe: there is nothing here to keep in sync,
 * so a dropped or reordered message costs at most one stale frame rather than
 * a corrupted island.
 */
self.onmessage = (event: MessageEvent<DeriveRequest>) => {
  const request = event.data
  if (request.type !== 'derive') return

  const started = performance.now()
  const snapshot = derive(request.state)

  const response: DeriveResponse = {
    type: 'snapshot',
    seq: request.seq,
    snapshot,
    elapsedMs: performance.now() - started,
  }

  // Every typed array is transferred rather than copied. The snapshot is dead
  // to the worker the moment it is posted, which is fine - it is regenerated
  // from scratch on the next request.
  self.postMessage(response, [
    snapshot.angle.buffer,
    snapshot.due.buffer,
    snapshot.jitter.buffer,
    snapshot.species.buffer,
    snapshot.stage.buffer,
    snapshot.scale.buffer,
    snapshot.regionIndex.buffer,
    snapshot.entityId.buffer,
  ])
}
