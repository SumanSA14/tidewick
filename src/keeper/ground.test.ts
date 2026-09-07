import { describe, it, expect } from 'vitest'
import { createGroundSampler, findFooting } from './ground'
import { WATER_LEVEL, KEEPER } from './controller'
import type { TerracedField } from '@/render/terrain/terrace'

/**
 * A tiny hand-built field, so the arithmetic is checkable by eye:
 * 4x4 cells over 40 world units, band 0..3, peak 12 -> 4 units per band.
 */
function field(bands: number[], land?: number[]): TerracedField {
  return {
    bands: Uint8Array.from(bands),
    land: Uint8Array.from(land ?? bands.map(() => 1)),
    size: 4,
    bandCount: 4,
    cellSize: 10,
    worldSize: 40,
    peakHeight: 12,
  }
}

const FLAT_SEA = [
  0, 0, 0, 0,
  0, 1, 1, 0,
  0, 1, 3, 0,
  0, 0, 0, 0,
]

describe('ground sampler', () => {
  it('maps a band to its world height', () => {
    const s = createGroundSampler(field(FLAT_SEA))
    // Cell (2,2) is band 3 of 3 -> full peak height.
    expect(s.heightAt(5, 5)).toBeCloseTo(12, 5)
    // Cell (1,1) is band 1 -> one third of the way up.
    expect(s.heightAt(-5, -5)).toBeCloseTo(4, 5)
  })

  it('does not interpolate across a riser', () => {
    // A terrace is drawn as a vertical wall. Interpolating would put the
    // Keeper's feet in mid-air halfway up it.
    const s = createGroundSampler(field(FLAT_SEA))
    const left = s.heightAt(-1, 5)
    const right = s.heightAt(1, 5)
    expect(left).not.toBeCloseTo(right, 3)
    // Both are exact band heights, not something in between.
    for (const h of [left, right]) expect(h % 4).toBeCloseTo(0, 5)
  })

  it('reports water outside the land mask', () => {
    const land = FLAT_SEA.map((b) => (b > 0 ? 1 : 0))
    const s = createGroundSampler(field(FLAT_SEA, land))
    expect(s.isLand(5, 5)).toBe(true)
    expect(s.isLand(-15, -15)).toBe(false)
    expect(s.heightAt(-15, -15)).toBeCloseTo(WATER_LEVEL - KEEPER.wadeDepth, 5)
  })

  it('treats everything outside the grid as open sea', () => {
    const s = createGroundSampler(field(FLAT_SEA))
    for (const [x, z] of [[500, 0], [-500, 0], [0, 500], [0, -500], [1e9, 1e9]]) {
      expect(s.isLand(x, z)).toBe(false)
      expect(Number.isFinite(s.heightAt(x, z))).toBe(true)
    }
  })

  it('puts the boundary between cells where the geometry does', () => {
    const s = createGroundSampler(field(FLAT_SEA))
    // World -20..20 over 4 cells: cell edges at -20, -10, 0, 10, 20.
    expect(s.heightAt(-0.01, 5)).not.toBe(s.heightAt(0.01, 5))
  })
})

describe('findFooting', () => {
  const land = FLAT_SEA.map((b) => (b > 0 ? 1 : 0))

  it('leaves a good position alone', () => {
    const found = findFooting(field(FLAT_SEA, land), 5, 5)
    expect(found).toEqual({ x: 5, z: 5 })
  })

  it('finds nearby land when the preferred spot is at sea', () => {
    const f = field(FLAT_SEA, land)
    const found = findFooting(f, -15, -15)
    expect(createGroundSampler(f).isLand(found.x, found.z)).toBe(true)
  })

  it('returns the closest land, not just any land', () => {
    const f = field(FLAT_SEA, land)
    // Just west of the band-1 cell at (-5,-5); that is what it should find.
    const found = findFooting(f, -12, -5)
    expect(Math.hypot(found.x - -12, found.z - -5)).toBeLessThan(15)
  })

  it('survives an island with no land at all', () => {
    const drowned = field([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], new Array(16).fill(0))
    const found = findFooting(drowned, 5, 5)
    expect(Number.isFinite(found.x)).toBe(true)
    expect(Number.isFinite(found.z)).toBe(true)
  })
})
