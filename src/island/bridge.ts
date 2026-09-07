import type { IslandSnapshot } from './derive'

/**
 * The GPU bridge: work out what actually changed, and upload only that.
 *
 * Section 11 forbids re-uploading a whole buffer because one task moved, and
 * the reason is the frame budget: a workspace change has to reach the island
 * inside 16 ms, and re-sending every instance attribute for a thousand plants
 * because someone ticked a checkbox spends that budget on nothing.
 *
 * The diff is per-instance and produces *contiguous ranges*, because that is
 * the shape a GPU upload wants - one `bufferSubData` per range rather than one
 * per changed element. Small gaps between dirty instances are deliberately
 * swallowed into a single range: two uploads separated by four untouched
 * floats cost more than one upload that includes them.
 */

export interface DirtyRange {
  start: number
  count: number
}

export interface BridgeDiff {
  /** Ranges of instance indices whose attributes changed. */
  ranges: DirtyRange[]
  /** True when the instance count changed and buffers must be reallocated. */
  resized: boolean
  /** Instances touched, for the HUD. */
  changed: number
  /** Bytes that will actually be sent, for the HUD. */
  bytes: number
}

/** Floats and bytes per instance, across every attribute the bridge uploads. */
export const FLOATS_PER_INSTANCE = 7
export const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4

/**
 * Merge dirty instances that are within this many slots of each other.
 *
 * Chosen because a GPU upload has a fixed cost per call that dwarfs a handful
 * of extra floats. Zero would produce a call per changed instance; a very large
 * value degenerates to re-uploading everything.
 */
const RANGE_MERGE_GAP = 16

export function diffSnapshots(previous: IslandSnapshot | null, next: IslandSnapshot): BridgeDiff {
  if (!previous || previous.count !== next.count) {
    return {
      ranges: next.count > 0 ? [{ start: 0, count: next.count }] : [],
      resized: true,
      changed: next.count,
      bytes: next.count * BYTES_PER_INSTANCE,
    }
  }

  if (previous.revision === next.revision) {
    // Nothing the island can see has changed. This is the common case while
    // someone is typing in a page body, and it costs one integer compare.
    return { ranges: [], resized: false, changed: 0, bytes: 0 }
  }

  const dirty: number[] = []
  for (let i = 0; i < next.count; i++) {
    if (
      previous.angle[i] !== next.angle[i] ||
      previous.due[i] !== next.due[i] ||
      previous.jitter[i] !== next.jitter[i] ||
      previous.species[i] !== next.species[i] ||
      previous.stage[i] !== next.stage[i] ||
      previous.scale[i] !== next.scale[i] ||
      previous.regionIndex[i] !== next.regionIndex[i] ||
      previous.entityId[i] !== next.entityId[i]
    ) {
      dirty.push(i)
    }
  }

  const ranges = coalesce(dirty, RANGE_MERGE_GAP)
  const uploaded = ranges.reduce((total, r) => total + r.count, 0)

  return {
    ranges,
    resized: false,
    changed: dirty.length,
    bytes: uploaded * BYTES_PER_INSTANCE,
  }
}

/** Turn sorted indices into contiguous ranges, merging gaps below `maxGap`. */
export function coalesce(indices: number[], maxGap: number): DirtyRange[] {
  if (indices.length === 0) return []
  const ranges: DirtyRange[] = []
  let start = indices[0]
  let end = indices[0]

  for (let i = 1; i < indices.length; i++) {
    const index = indices[i]
    if (index - end <= maxGap) {
      end = index
    } else {
      ranges.push({ start, count: end - start + 1 })
      start = index
      end = index
    }
  }
  ranges.push({ start, count: end - start + 1 })
  return ranges
}

/**
 * Write one snapshot range into the interleaved instance buffer.
 *
 * Interleaved rather than one buffer per attribute: a plant's fields all change
 * together, so keeping them adjacent turns eight small uploads into one, and
 * the diff above only has to describe a single range.
 *
 * Layout per instance: angle, due, jitter, species, stage, scale, entityId.
 * regionIndex is folded into species because both are small integers and the
 * shader wants a single fetch.
 */
export function writeRange(
  target: Float32Array,
  snapshot: IslandSnapshot,
  range: DirtyRange,
): void {
  const end = Math.min(range.start + range.count, snapshot.count)
  for (let i = range.start; i < end; i++) {
    const at = i * FLOATS_PER_INSTANCE
    target[at] = snapshot.angle[i]
    target[at + 1] = snapshot.due[i]
    target[at + 2] = snapshot.jitter[i]
    // Species in the integer part, region in the fraction: both are small, and
    // a float attribute is the only thing every backend agrees about.
    target[at + 3] = snapshot.species[i] + snapshot.regionIndex[i] / 256
    target[at + 4] = snapshot.stage[i]
    target[at + 5] = snapshot.scale[i]
    target[at + 6] = snapshot.entityId[i]
  }
}

/** Fill the whole buffer. Used on the first upload and after a resize. */
export function writeAll(target: Float32Array, snapshot: IslandSnapshot): void {
  writeRange(target, snapshot, { start: 0, count: snapshot.count })
}
