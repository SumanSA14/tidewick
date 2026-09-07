import { TERRAIN } from '@/core/config'
import { clamp } from '@/core/rng'
import type { Heightfield } from './heightfield'

/**
 * Terracing: the step that reconciles the two halves of the art direction.
 *
 * The brief asks for hydraulic erosion; the reference art is chunky flat-shaded
 * low-poly with hard cliff faces. Those look like different products until you
 * run them in sequence - erode the continuous field first, so water carves real
 * drainage channels, and only then quantise height into discrete bands. The
 * cliff walls end up following the eroded valley network, which is exactly the
 * stepped-plateau silhouette in the reference and is something neither step
 * produces alone.
 *
 * Top faces carry the biome colour. Wall faces are always stone. That single
 * rule is most of why the reference images read as they do.
 */

export interface TerracedField {
  /** Band index per cell, row-major, `size * size`. */
  bands: Uint8Array
  /** True where the cell is land at all. Ocean cells are not meshed. */
  land: Uint8Array
  size: number
  bandCount: number
  /** World-space metres per cell. */
  cellSize: number
  worldSize: number
  peakHeight: number
}

/** Below this normalised height a cell is open water, not beach. */
const LAND_EPSILON = 0.004

/**
 * Height remap applied before quantising.
 *
 * Erosion is a sediment *transport* process: it takes material off the ridges
 * and puts it in the lowlands, so the post-erosion height distribution is
 * strongly bottom-heavy. Quantising it directly puts nearly a third of the
 * island into band zero - one enormous flat sand plain where a beach should be
 * - while the top band goes almost unused.
 *
 * An exponent below 1 lifts the low end and spreads the coastal cells across
 * the first few bands. This is safe to do here because it is purely about where
 * the *land* sits; plant elevation still maps linearly to time remaining in
 * world-Y, which is the invariant that actually matters.
 */
const HEIGHT_CURVE = 0.72

export function terrace(
  field: Heightfield,
  bandCount = TERRAIN.terraceBands,
  worldSize = TERRAIN.worldSize,
  peakHeight = TERRAIN.peakHeight,
): TerracedField {
  const { data, size } = field
  const bands = new Uint8Array(size * size)
  const land = new Uint8Array(size * size)

  for (let i = 0; i < data.length; i++) {
    const h = data[i]
    if (h < LAND_EPSILON) continue
    land[i] = 1
    bands[i] = clamp(Math.floor(Math.pow(h, HEIGHT_CURVE) * bandCount), 0, bandCount - 1)
  }

  return {
    bands,
    land,
    size,
    bandCount,
    cellSize: worldSize / size,
    worldSize,
    peakHeight,
  }
}

/** World-space Y of a band's flat top. Band 0 sits exactly at the waterline. */
export function bandHeight(band: number, bandCount: number, peakHeight: number): number {
  return (band / (bandCount - 1)) * peakHeight
}

/**
 * The height of the ground at a world position, for anything that stands on it.
 * Deliberately returns the *terraced* height and not the smooth one, because
 * a plant floating half a metre above its plateau is immediately visible.
 */
export function sampleGroundHeight(t: TerracedField, worldX: number, worldZ: number): number {
  const half = t.worldSize / 2
  const gx = Math.floor(((worldX + half) / t.worldSize) * t.size)
  const gz = Math.floor(((worldZ + half) / t.worldSize) * t.size)
  if (gx < 0 || gz < 0 || gx >= t.size || gz >= t.size) return 0
  const i = gz * t.size + gx
  if (!t.land[i]) return 0
  return bandHeight(t.bands[i], t.bandCount, t.peakHeight)
}

export interface TerrainGeometryData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  vertexCount: number
  /** Number of top-face triangles, for the HUD breakdown. */
  topTriangles: number
  wallTriangles: number
}

/**
 * Band palette.
 *
 * The thresholds are not evenly spaced because the *island* is not. The height
 * remap pushes mass upward, so the mode of the band histogram sits high - on a
 * measured isle, bands 8 and 9 (t 0.73 and 0.82) are the two largest bands
 * after the beach, together nearly a third of all land.
 *
 * An earlier version put the desaturation ramp at t 0.62, which dropped that
 * entire cluster into grey-green scrub: 42.7% of the island painted as washed
 * out upland, while the pale "misty top" band it was saving room for covered
 * 1% and the top band held no cells at all. The comment there claimed the stops
 * followed the real histogram; measuring it showed they inverted it.
 *
 * So green now runs most of the way up, and stone is reserved for ground that
 * is genuinely near the summit. `desaturatedFraction` in the tests keeps this
 * honest across seeds - terrain is per-workspace, so "it looks right on mine"
 * is not an answer.
 */
function biomeColour(band: number, bandCount: number, out: [number, number, number]): void {
  const t = band / Math.max(1, bandCount - 1)
  if (band === 0) {
    // Beach.
    out[0] = 0.96; out[1] = 0.90; out[2] = 0.71
  } else if (t < 0.32) {
    // Bright shore grass. The most saturated colour on the island, and the one
    // the eye lands on first, so it sits where the land meets the sand.
    const k = t / 0.32
    out[0] = 0.58 - k * 0.12
    out[1] = 0.85 - k * 0.08
    out[2] = 0.37 - k * 0.04
  } else if (t < 0.80) {
    // Deeper meadow, climbing away from the salt. This is the bulk of the
    // island and it stays green the whole way.
    const k = (t - 0.32) / 0.48
    out[0] = 0.46 - k * 0.10
    out[1] = 0.77 - k * 0.13
    out[2] = 0.33 + k * 0.02
  } else if (t < 0.93) {
    // Upland scrub, moss over stone. Desaturating, not brightening - and only
    // once the ground is genuinely high.
    const k = (t - 0.80) / 0.13
    out[0] = 0.36 + k * 0.16
    out[1] = 0.64 - k * 0.06
    out[2] = 0.35 + k * 0.13
  } else {
    // The misty tops. Cool and pale, but only ever the peak.
    const k = (t - 0.93) / 0.07
    out[0] = 0.52 + k * 0.20
    out[1] = 0.58 + k * 0.16
    out[2] = 0.48 + k * 0.20
  }
}

/** Above this height fraction the palette leaves green for stone. */
export const DESATURATION_START = 0.80


const STONE: [number, number, number] = [0.60, 0.60, 0.62]

/**
 * The colour of a terrace riser.
 *
 * Not a constant. Painting every wall the same grey put scattered stone crates
 * across the grass: a single-band riser is barely two metres, and on a wide
 * green plateau a short grey slab reads as a dropped box rather than as a step
 * in the land.
 *
 * So the riser starts as the biome it falls away from, darkened the way a
 * vertical face in its own shadow would be, and only turns to stone as the drop
 * gets deep enough to be an actual cliff. A one-band step is a grassy edge; a
 * four-band drop is rock. That is also what the terraced-hillside reference art
 * does - the risers are the same material as the treads until the drop is big.
 */
function wallColour(
  band: number,
  bandCount: number,
  drop: number,
  out: [number, number, number],
): void {
  biomeColour(band, bandCount, out)

  // A vertical face catches less sky than the tread above it.
  out[0] *= 0.78
  out[1] *= 0.78
  out[2] *= 0.80

  // Stone shows through as the drop deepens. Full rock by four bands, which is
  // roughly nine units here - unambiguously a cliff rather than a step.
  const rock = Math.min(1, Math.max(0, (drop - 1) / 3)) * 0.85
  if (rock <= 0) return
  out[0] += (STONE[0] - out[0]) * rock
  out[1] += (STONE[1] - out[1]) * rock
  out[2] += (STONE[2] - out[2]) * rock
}

/**
 * sRGB to linear-light transfer.
 *
 * three treats a vertex-colour attribute as linear-light values, then converts
 * to sRGB on output. Palette numbers are picked by eye, which means they are
 * picked in sRGB - handing them over raw applies the conversion a second time
 * and every colour on the island comes out muddy and dark. This is the step
 * that makes the greens read as the reference art rather than as swamp.
 */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Builds one non-indexed, flat-shaded mesh for the whole island.
 *
 * Non-indexed is deliberate: hard normals are the entire point of the look, and
 * sharing vertices between faces would smooth exactly the creases we want. It
 * costs memory and buys one draw call for the terrain, which is the right trade
 * against a budget of under 200 draw calls per frame.
 */
export function buildTerrainGeometry(t: TerracedField): TerrainGeometryData {
  const { size, bands, land, bandCount, cellSize, peakHeight } = t
  const half = t.worldSize / 2

  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  let topTriangles = 0
  let wallTriangles = 0

  const rgb: [number, number, number] = [0, 0, 0]
  const wallRgb: [number, number, number] = [0, 0, 0]

  const pushVert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: readonly number[]) => {
    positions.push(x, y, z)
    normals.push(nx, ny, nz)
    colors.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
  }

  for (let gz = 0; gz < size; gz++) {
    for (let gx = 0; gx < size; gx++) {
      const i = gz * size + gx
      if (!land[i]) continue

      const band = bands[i]
      const y = bandHeight(band, bandCount, peakHeight)

      const x0 = gx * cellSize - half
      const x1 = x0 + cellSize
      const z0 = gz * cellSize - half
      const z1 = z0 + cellSize

      biomeColour(band, bandCount, rgb)

      // Top face, two triangles, normal straight up.
      pushVert(x0, y, z0, 0, 1, 0, rgb)
      pushVert(x0, y, z1, 0, 1, 0, rgb)
      pushVert(x1, y, z1, 0, 1, 0, rgb)
      pushVert(x0, y, z0, 0, 1, 0, rgb)
      pushVert(x1, y, z1, 0, 1, 0, rgb)
      pushVert(x1, y, z0, 0, 1, 0, rgb)
      topTriangles += 2

      // Walls wherever a neighbour sits lower, or where the land ends.
      // Ocean-side walls drop below the waterline so there is no visible seam
      // between the beach and the sea surface.
      const neighbours: Array<[number, number, number, number]> = [
        [gx - 1, gz, -1, 0],
        [gx + 1, gz, 1, 0],
        [gx, gz - 1, 0, -1],
        [gx, gz + 1, 0, 1],
      ]

      for (const [nx, nz, dirX, dirZ] of neighbours) {
        let neighbourY: number
        let neighbourBand: number
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) {
          neighbourY = -3
          neighbourBand = -1
        } else {
          const ni = nz * size + nx
          const isLand = land[ni] !== 0
          neighbourY = isLand ? bandHeight(bands[ni], bandCount, peakHeight) : -3
          neighbourBand = isLand ? bands[ni] : -1
        }
        if (neighbourY >= y - 1e-4) continue

        // Shore walls drop to the sea floor; treat them as a full cliff so the
        // waterline keeps its rock edge instead of turning into grass.
        const drop = neighbourBand < 0 ? bandCount : band - neighbourBand
        wallColour(band, bandCount, drop, wallRgb)

        // Wall quad spanning the drop, facing outward from this cell.
        let ax: number, az: number, bx: number, bz: number
        if (dirX === -1) { ax = x0; az = z1; bx = x0; bz = z0 }
        else if (dirX === 1) { ax = x1; az = z0; bx = x1; bz = z1 }
        else if (dirZ === -1) { ax = x0; az = z0; bx = x1; bz = z0 }
        else { ax = x1; az = z1; bx = x0; bz = z1 }

        // Wound so the face points along (dirX, 0, dirZ), i.e. away from this
        // cell. Reversing these two triangles back-faces every cliff in the
        // island, which culls them and leaves dark holes in the terraces.
        pushVert(ax, y, az, dirX, 0, dirZ, wallRgb)
        pushVert(bx, neighbourY, bz, dirX, 0, dirZ, wallRgb)
        pushVert(ax, neighbourY, az, dirX, 0, dirZ, wallRgb)
        pushVert(ax, y, az, dirX, 0, dirZ, wallRgb)
        pushVert(bx, y, bz, dirX, 0, dirZ, wallRgb)
        pushVert(bx, neighbourY, bz, dirX, 0, dirZ, wallRgb)
        wallTriangles += 2
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    vertexCount: positions.length / 3,
    topTriangles,
    wallTriangles,
  }
}
