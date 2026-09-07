import { describe, it, expect } from 'vitest'
import { LineSegments } from 'three'
import { createFootpaths } from './footpaths'
import { buildRadialProfile } from './terrain/profile'
import { EMPTY_SNAPSHOT, STAGE, type IslandSnapshot } from '@/island/derive'
import type { TerracedField } from './terrain/terrace'

/**
 * Footpaths are independent segments, not one strip.
 *
 * The buffer holds vertex *pairs*, and it was drawn as a `Line` - which joins
 * every vertex to the next. That drew each segment twice, and ran a stray
 * connector from the end of one path to the start of the next, across the
 * island between two plants that had nothing to do with each other.
 */

function flatField(): TerracedField {
  const size = 16
  return {
    bands: new Uint8Array(size * size).fill(2),
    land: new Uint8Array(size * size).fill(1),
    size,
    bandCount: 4,
    cellSize: 10,
    worldSize: 160,
    peakHeight: 12,
  }
}

function snapshotWithPaths(): IslandSnapshot {
  const due = Date.now() + 20 * 86_400_000
  return {
    ...EMPTY_SNAPSHOT,
    count: 4,
    angle: Float32Array.from([0.2, 0.9, 2.4, 3.1]),
    due: Float32Array.from([due, due, due, due]),
    jitter: new Float32Array(4).fill(0.5),
    species: new Uint8Array(4),
    stage: new Uint8Array(4).fill(STAGE.seed),
    scale: new Float32Array(4).fill(1),
    regionIndex: new Uint8Array(4),
    entityId: Uint32Array.from([1, 2, 3, 4]),
    ids: ['a', 'b', 'c', 'd'],
    // Two unrelated paths on opposite sides of the isle.
    paths: [
      { from: 0, to: 1, traffic: 1 },
      { from: 2, to: 3, traffic: 0.5 },
    ],
    revision: 1,
  }
}

describe('footpaths', () => {
  it('draws independent segments, not a strip', () => {
    const paths = createFootpaths()
    expect(paths.line).toBeInstanceOf(LineSegments)
  })

  it('never joins the end of one path to the start of the next', () => {
    const paths = createFootpaths()
    const profile = buildRadialProfile(flatField(), 32, 24)
    const snapshot = snapshotWithPaths()
    paths.rebuild(snapshot, profile, Date.now())

    const positions = paths.line.geometry.getAttribute('position')
    // Every segment is two vertices, so the count is even and the segments are
    // exactly the ones the paths asked for.
    expect(positions.count % 2).toBe(0)

    // Within a segment the two endpoints are close; a connector between the
    // two paths would be a segment spanning most of the island.
    let longest = 0
    for (let i = 0; i < positions.count; i += 2) {
      const dx = positions.getX(i + 1) - positions.getX(i)
      const dz = positions.getZ(i + 1) - positions.getZ(i)
      longest = Math.max(longest, Math.hypot(dx, dz))
    }
    // Paths are subdivided into 14 segments; one segment is a small fraction
    // of the path, never a chord across the isle.
    expect(longest).toBeLessThan(40)
  })

  it('hides itself when there are no paths', () => {
    const paths = createFootpaths()
    const profile = buildRadialProfile(flatField(), 32, 24)
    paths.rebuild({ ...snapshotWithPaths(), paths: [] }, profile, Date.now())
    expect(paths.line.visible).toBe(false)
  })
})
