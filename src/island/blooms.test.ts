import { describe, it, expect } from 'vitest'
import { newlyLit, bloomStage, bloomFinished, BLOOM_SECONDS } from './blooms'
import { EMPTY_SNAPSHOT, STAGE, type IslandSnapshot } from './derive'

/**
 * The bloom-and-lantern sequence.
 *
 * Presentation, not derivation - the snapshot says a task is done, and this
 * layer notices that it just *became* done. Keeping the two apart is what lets
 * `derive()` stay clock-free.
 */

function snapshotOf(plants: Array<{ id: string; stage: number }>): IslandSnapshot {
  const count = plants.length
  return {
    ...EMPTY_SNAPSHOT,
    count,
    paths: [],
    angle: new Float32Array(count),
    due: new Float32Array(count),
    jitter: new Float32Array(count),
    species: new Uint8Array(count),
    stage: Uint8Array.from(plants.map((p) => p.stage)),
    scale: new Float32Array(count).fill(1),
    regionIndex: new Uint8Array(count),
    entityId: Uint32Array.from(plants.map((_, i) => i + 1)),
    ids: plants.map((p) => p.id),
    revision: 1,
  }
}

describe('newlyLit', () => {
  it('fires when a task is completed', () => {
    const before = snapshotOf([{ id: 'a', stage: STAGE.seed }])
    const after = snapshotOf([{ id: 'a', stage: STAGE.lantern }])
    expect(newlyLit(before, after, 10)).toEqual([{ index: 0, startedAt: 10 }])
  })

  it('does not fire for a task that was already done', () => {
    const before = snapshotOf([{ id: 'a', stage: STAGE.lantern }])
    const after = snapshotOf([{ id: 'a', stage: STAGE.lantern }])
    expect(newlyLit(before, after, 10)).toEqual([])
  })

  it('does not fire for a task that is still growing', () => {
    const before = snapshotOf([{ id: 'a', stage: STAGE.seed }])
    const after = snapshotOf([{ id: 'a', stage: STAGE.sapling }])
    expect(newlyLit(before, after, 10)).toEqual([])
  })

  it('does not fire on the first snapshot', () => {
    // Opening an isle full of finished work must not set off a firework
    // display for tasks completed weeks ago.
    const after = snapshotOf([
      { id: 'a', stage: STAGE.lantern },
      { id: 'b', stage: STAGE.lantern },
    ])
    expect(newlyLit(null, after, 10)).toEqual([])
    expect(newlyLit(EMPTY_SNAPSHOT, after, 10)).toEqual([])
  })

  it('does not fire for a task that arrives already complete', () => {
    // An import, or an undo that brings a finished row back. It was not
    // finished in front of you, so it lights quietly.
    const before = snapshotOf([{ id: 'a', stage: STAGE.seed }])
    const after = snapshotOf([
      { id: 'a', stage: STAGE.seed },
      { id: 'imported', stage: STAGE.lantern },
    ])
    expect(newlyLit(before, after, 10)).toEqual([])
  })

  it('tracks tasks by id, not by position', () => {
    // Rows are reordered, inserted and deleted constantly. Comparing by index
    // would fire blooms for plants nobody touched.
    const before = snapshotOf([
      { id: 'a', stage: STAGE.lantern },
      { id: 'b', stage: STAGE.seed },
    ])
    // 'b' moved to the front and is still unfinished; 'a' is still done.
    const after = snapshotOf([
      { id: 'b', stage: STAGE.seed },
      { id: 'a', stage: STAGE.lantern },
    ])
    expect(newlyLit(before, after, 10)).toEqual([])
  })

  it('finds the right index after a reorder', () => {
    const before = snapshotOf([
      { id: 'a', stage: STAGE.seed },
      { id: 'b', stage: STAGE.seed },
    ])
    const after = snapshotOf([
      { id: 'b', stage: STAGE.seed },
      { id: 'a', stage: STAGE.lantern },
    ])
    expect(newlyLit(before, after, 5)).toEqual([{ index: 1, startedAt: 5 }])
  })

  it('reports several completions at once', () => {
    const before = snapshotOf([
      { id: 'a', stage: STAGE.seed },
      { id: 'b', stage: STAGE.seed },
      { id: 'c', stage: STAGE.seed },
    ])
    const after = snapshotOf([
      { id: 'a', stage: STAGE.lantern },
      { id: 'b', stage: STAGE.seed },
      { id: 'c', stage: STAGE.lantern },
    ])
    expect(newlyLit(before, after, 3).map((b) => b.index)).toEqual([0, 2])
  })

  it('does not fire when a completed task is un-completed', () => {
    // Un-ticking a box is not a completion, and it must not be a celebration.
    const before = snapshotOf([{ id: 'a', stage: STAGE.lantern }])
    const after = snapshotOf([{ id: 'a', stage: STAGE.seed }])
    expect(newlyLit(before, after, 10)).toEqual([])
  })
})

describe('bloomStage', () => {
  it('starts at the sapling stage', () => {
    expect(bloomStage(0)).toBeCloseTo(STAGE.sapling, 5)
  })

  it('ends exactly at the lantern stage', () => {
    expect(bloomStage(BLOOM_SECONDS)).toBe(STAGE.lantern)
    expect(bloomStage(BLOOM_SECONDS * 10)).toBe(STAGE.lantern)
  })

  it('swells past the final size before settling', () => {
    // The overshoot is what makes it read as blooming rather than growing.
    const mid = bloomStage(BLOOM_SECONDS * 0.55)
    expect(mid).toBeGreaterThan(STAGE.lantern)
  })

  it('settles back down at the end', () => {
    const peak = bloomStage(BLOOM_SECONDS * 0.55)
    const late = bloomStage(BLOOM_SECONDS * 0.95)
    expect(late).toBeLessThan(peak)
  })

  it('rises overall from start to finish', () => {
    expect(bloomStage(BLOOM_SECONDS * 0.2)).toBeGreaterThan(bloomStage(0))
    expect(bloomStage(BLOOM_SECONDS)).toBeGreaterThan(bloomStage(0))
  })

  it('is finite and bounded throughout', () => {
    for (let t = -1; t <= BLOOM_SECONDS * 2; t += 0.05) {
      const stage = bloomStage(t)
      expect(Number.isFinite(stage)).toBe(true)
      expect(stage).toBeGreaterThanOrEqual(STAGE.sapling)
      expect(stage).toBeLessThan(STAGE.lantern + 0.5)
    }
  })

  it('is unhurried', () => {
    // This is the reward the whole loop builds to; it gets its time.
    expect(BLOOM_SECONDS).toBeGreaterThan(1)
  })
})

describe('bloomFinished', () => {
  it('is false during and true after', () => {
    expect(bloomFinished(0)).toBe(false)
    expect(bloomFinished(BLOOM_SECONDS * 0.99)).toBe(false)
    expect(bloomFinished(BLOOM_SECONDS)).toBe(true)
  })
})
