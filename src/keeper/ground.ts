import type { TerracedField } from '@/render/terrain/terrace'
import type { GroundSampler } from './controller'
import { WATER_LEVEL, KEEPER } from './controller'

/**
 * The adapter between the terrain and the Keeper.
 *
 * The controller knows nothing about terraces, meshes or three.js; it asks two
 * questions and this answers them. Keeping the seam here is what let the
 * controller be tested against a synthetic hillside.
 *
 * **Sampling is deliberately not interpolated.** A terraced island is a step
 * function by construction, and smoothing it would put the Keeper's feet
 * halfway up a riser that is drawn as a vertical wall - the character would
 * visibly float. Nearest-cell is the honest sample: the floor is where the
 * geometry is.
 */
export function createGroundSampler(field: TerracedField): GroundSampler {
  const { bands, land, size, bandCount, worldSize, peakHeight } = field
  const half = worldSize / 2
  const scale = size / worldSize
  const bandHeight = peakHeight / Math.max(1, bandCount - 1)

  /** World position to cell index, or -1 outside the grid. */
  const cellAt = (x: number, z: number): number => {
    const gx = Math.floor((x + half) * scale)
    const gz = Math.floor((z + half) * scale)
    if (gx < 0 || gz < 0 || gx >= size || gz >= size) return -1
    return gz * size + gx
  }

  return {
    heightAt(x, z) {
      const i = cellAt(x, z)
      if (i < 0 || !land[i]) return WATER_LEVEL - KEEPER.wadeDepth
      return bands[i] * bandHeight
    },
    isLand(x, z) {
      const i = cellAt(x, z)
      return i >= 0 && land[i] !== 0
    },
  }
}

/**
 * A safe place to put the Keeper down.
 *
 * Used on first spawn and whenever the terrain is regenerated under the
 * Keeper's feet - a workspace rename changes the seed, and the ground the
 * Keeper was standing on may simply no longer be land.
 *
 * Spirals outward from a preferred point rather than scanning the whole grid,
 * so the common case (the point is already fine) costs one lookup.
 */
export function findFooting(
  field: TerracedField,
  preferX = 0,
  preferZ = 0,
): { x: number; z: number } {
  const sampler = createGroundSampler(field)
  if (sampler.isLand(preferX, preferZ)) return { x: preferX, z: preferZ }

  const step = field.cellSize
  const maxRings = Math.ceil(field.size / 2)

  for (let ring = 1; ring < maxRings; ring++) {
    const radius = ring * step
    // Enough samples that the arc between them stays under a cell.
    const samples = Math.max(8, Math.ceil((Math.PI * 2 * radius) / step))
    for (let s = 0; s < samples; s++) {
      const angle = (s / samples) * Math.PI * 2
      const x = preferX + Math.cos(angle) * radius
      const z = preferZ + Math.sin(angle) * radius
      if (sampler.isLand(x, z)) return { x, z }
    }
  }

  // An island with no land at all is a terrain bug, not a Keeper bug, but
  // returning the centre keeps the character on screen while it is diagnosed.
  return { x: 0, z: 0 }
}
