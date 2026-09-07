import { Perlin2D, clamp, smoothstep } from '@/core/rng'
import { TERRAIN } from '@/core/config'

/** The highlands sit off the origin, so the island is not a cone. */
const PEAK_OFFSET_X = -0.24
const PEAK_OFFSET_Y = 0.17

export interface Heightfield {
  /** Row-major, size * size, normalised to roughly [0, 1]. */
  data: Float32Array
  size: number
}

/**
 * The island's base landmass, before erosion.
 *
 * The naive construction - noise multiplied by a radial falloff - produces a
 * disc, because the radial term dominates the contour shape and every terrace
 * comes out as a concentric ring. Instead the noise defines the landmass and
 * the radial term is *subtracted* from it, so the coastline lands wherever
 * terrain height happens to fall to zero. That makes the silhouette a property
 * of the noise, which is what gives bays, headlands and offshore stacks, while
 * the falloff still guarantees the result is an island rather than a continent
 * running off the edge of the map.
 *
 * Ridged noise supplies a spine for the erosion pass to carve drainage against.
 * Erosion applied to smooth fbm produces mush: there are no ridgelines for
 * water to run off, so nothing concentrates into channels.
 */
export function generateBaseHeightfield(seed: number, size = TERRAIN.gridSize): Heightfield {
  const shape = new Perlin2D(seed)
  const detail = new Perlin2D(seed ^ 0x9e3779b9)
  const warp = new Perlin2D(seed ^ 0x85ebca6b)

  const data = new Float32Array(size * size)
  const inv = 1 / (size - 1)

  /**
   * The domain warp at half resolution, bilinearly upsampled.
   *
   * The warp is six of the twenty-four noise evaluations per cell and is, by
   * construction, low-frequency - a 1.35x field over the island. Sampling it on
   * a half-size grid and interpolating loses nothing visible and takes a
   * quarter of the warp's cost, which is most of what brings base generation
   * in a cold worker from ~130 ms to inside the terrain budget.
   */
  const warpSize = (size >> 1) + 1
  const warpInv = 1 / (warpSize - 1)
  const warpX = new Float32Array(warpSize * warpSize)
  const warpY = new Float32Array(warpSize * warpSize)
  for (let y = 0; y < warpSize; y++) {
    for (let x = 0; x < warpSize; x++) {
      const nx = x * warpInv * 2 - 1
      const ny = y * warpInv * 2 - 1
      const i = y * warpSize + x
      warpX[i] = warp.fbm(nx * 1.35 + 11.3, ny * 1.35 - 4.7, 3) * 0.55
      warpY[i] = warp.fbm(nx * 1.35 - 8.1, ny * 1.35 + 2.9, 3) * 0.55
    }
  }
  const sampleWarp = (field: Float32Array, u: number, v: number): number => {
    const fx = u * (warpSize - 1)
    const fy = v * (warpSize - 1)
    const x0 = Math.min(warpSize - 2, Math.floor(fx))
    const y0 = Math.min(warpSize - 2, Math.floor(fy))
    const tx = fx - x0
    const ty = fy - y0
    const i = y0 * warpSize + x0
    return (field[i] * (1 - tx) + field[i + 1] * tx) * (1 - ty)
      + (field[i + warpSize] * (1 - tx) + field[i + warpSize + 1] * tx) * ty
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normalised coordinates centred on the origin, in [-1, 1].
      const nx = x * inv * 2 - 1
      const ny = y * inv * 2 - 1

      // Domain warp, applied hard. This is most of what stops the island
      // reading as a circle with contour lines drawn on it.
      const wx = nx + sampleWarp(warpX, x * inv, y * inv)
      const wy = ny + sampleWarp(warpY, x * inv, y * inv)

      const dist = Math.sqrt(wx * wx + wy * wy)

      // Two ridged layers rather than one. A single low-frequency layer
      // averages out to a dome and the island reads as a hill with contour
      // lines on it; the massif layer decides where the highlands are, and the
      // spine layer breaks them into separate ridges and valleys.
      const massif = shape.ridged(wx * 1.15 + 3.7, wy * 1.15 - 2.1, 3)
      const spine = shape.ridged(wx * 2.6, wy * 2.6, 4)
      const rolling = detail.fbm(wx * 2.4, wy * 2.4, 4) * 0.5 + 0.5
      const fine = detail.fbm(wx * 5.5, wy * 5.5, 1) * 0.5 + 0.5

      // Sea pressure rises with distance from the centre. Where the land value
      // fails to beat it there is water, so the coastline is a property of the
      // noise rather than of the radius.
      const seaPressure = Math.pow(dist, 2.6) * 3.0
      const coastField = (massif * 0.5 + spine * 0.3 + rolling * 0.2) - seaPressure
      if (coastField <= 0) continue

      // Mask and relief are deliberately separate.
      //
      // Subtracting sea pressure directly from the height - the obvious
      // construction - makes height decrease monotonically with radius no
      // matter what the noise does, so every terrace comes out as a concentric
      // ring and the island is a cone. Here the mask decides *where* land is
      // and the relief decides *how high* it is, and the relief never consults
      // the radius at all. That is what makes contours follow ridgelines.
      //
      // The mask ramp is short on purpose: a long one spreads the whole coast
      // across band zero and produces a beach wider than the island.
      const mask = smoothstep(0, 0.022, coastField)
      const relief = massif * 0.40 + spine * 0.40 + rolling * 0.14 + fine * 0.06

      // A gentle dome so the highlands are genuinely high and the far future
      // has somewhere to sit. Off-centre, because a dome on the origin
      // reintroduces exactly the radial symmetry this rewrite removes.
      const dx = wx - PEAK_OFFSET_X
      const dy = wy - PEAK_OFFSET_Y
      const domeDist = Math.sqrt(dx * dx + dy * dy)
      const dome = 1 + smoothstep(1.1, 0.0, domeDist) * 0.34

      data[y * size + x] = clamp(relief * dome * mask, 0, 4)
    }
  }

  return normalise({ data, size })
}

/** Rescale so the tallest point is exactly 1 and the lowest land is 0. */
export function normalise(field: Heightfield): Heightfield {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < field.data.length; i++) {
    const v = field.data[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (range > 1e-6) {
    const scale = 1 / range
    for (let i = 0; i < field.data.length; i++) {
      field.data[i] = (field.data[i] - min) * scale
    }
  }
  return field
}

/** Bilinear sample of a heightfield in grid coordinates. */
export function sampleBilinear(field: Heightfield, x: number, y: number): number {
  const { data, size } = field
  const cx = clamp(x, 0, size - 1.001)
  const cy = clamp(y, 0, size - 1.001)
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const fx = cx - x0
  const fy = cy - y0
  const i = y0 * size + x0
  const h00 = data[i]
  const h10 = data[i + 1]
  const h01 = data[i + size]
  const h11 = data[i + size + 1]
  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  )
}

/** Downsample by box-averaging. Erosion wants resolution; terracing wants chunk. */
export function downsample(field: Heightfield, targetSize: number): Heightfield {
  const { data, size } = field
  if (targetSize >= size) return field
  const out = new Float32Array(targetSize * targetSize)
  const ratio = size / targetSize
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const sx0 = Math.floor(x * ratio)
      const sy0 = Math.floor(y * ratio)
      const sx1 = Math.min(size, Math.floor((x + 1) * ratio))
      const sy1 = Math.min(size, Math.floor((y + 1) * ratio))
      let sum = 0
      let count = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += data[sy * size + sx]
          count++
        }
      }
      out[y * targetSize + x] = count > 0 ? sum / count : 0
    }
  }
  return { data: out, size: targetSize }
}

/**
 * Separable box blur over the heightfield, in place of a Gaussian.
 *
 * This is the step that makes terracing look like the reference art rather
 * than like a contour map of static. Erosion output is deliberately
 * high-frequency - channels are narrow - and quantising it directly turns
 * every one-cell wobble into its own cliff, shattering the island into
 * thousands of tiny steps. Smoothing first keeps the large-scale drainage that
 * erosion produced while letting band boundaries settle into long, walkable
 * plateau edges.
 *
 * Applied only to the *terracing* copy. The full-resolution field is kept
 * unsmoothed for the shore blend and for anything that needs true height.
 */
export function smoothField(field: Heightfield, iterations = 3, radius = 1): Heightfield {
  const { size } = field
  let src = field.data
  let dst = new Float32Array(src.length)

  for (let pass = 0; pass < iterations; pass++) {
    // Horizontal.
    for (let y = 0; y < size; y++) {
      const row = y * size
      for (let x = 0; x < size; x++) {
        let sum = 0
        let n = 0
        for (let k = -radius; k <= radius; k++) {
          const sx = x + k
          if (sx < 0 || sx >= size) continue
          sum += src[row + sx]
          n++
        }
        dst[row + x] = sum / n
      }
    }
    // Vertical.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0
        let n = 0
        for (let k = -radius; k <= radius; k++) {
          const sy = y + k
          if (sy < 0 || sy >= size) continue
          sum += dst[sy * size + x]
          n++
        }
        src[y * size + x] = sum / n
      }
    }
  }

  return { data: src, size }
}
