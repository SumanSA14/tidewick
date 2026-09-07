import { EROSION, TERRAIN } from '@/core/config'
import { mulberry32 } from '@/core/rng'
import type { Heightfield } from './heightfield'

/**
 * Droplet-based hydraulic erosion, CPU reference implementation.
 *
 * This exists for two reasons and both matter:
 *   1. It is the WebGL2 fallback path, because WebGL2 has no compute shaders.
 *      Three's TSL falls back for *materials*, but renderer.compute() requires
 *      the WebGPU backend, so the simulation has to run somewhere else.
 *   2. It is the control in the CPU-vs-GPU benchmark recorded in the README.
 *      "The GPU is faster" is a claim; a measured table is evidence.
 *
 * The algorithm follows Hans Beyer's droplet formulation: a particle of water
 * is dropped at a random point, follows the height gradient downhill, picks up
 * sediment where it accelerates and deposits it where it slows, and evaporates
 * over its lifetime. Thousands of these carve believable drainage networks that
 * no amount of noise stacking will produce, because real valleys are the
 * *history* of water, not a frequency band.
 */

interface ErosionBrush {
  /**
   * Flat index offsets (dy * size + dx) rather than (dx, dy) pairs. The brush
   * runs on the order of ten million times per island, and turning two loads,
   * a multiply and an add into a single add is most of what took the erosion
   * pass from 315 ms to inside the 400 ms budget.
   */
  offsets: Int32Array
  weights: Float32Array
  count: number
  /** Cells from the edge a droplet must stay to keep every tap in bounds. */
  margin: number
}

/**
 * Precomputed weighted disc used to spread a single droplet's erosion over
 * neighbouring cells. Without it, droplets cut one-pixel-wide trenches.
 *
 * Built for one grid size, because the offsets are flat indices into it.
 */
function buildBrush(radius: number, size: number): ErosionBrush {
  const offsets: number[] = []
  const weights: number[] = []
  let weightSum = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sqrDist = dx * dx + dy * dy
      if (sqrDist >= radius * radius) continue
      const w = 1 - Math.sqrt(sqrDist) / radius
      weightSum += w
      offsets.push(dy * size + dx)
      weights.push(w)
    }
  }
  const normalised = new Float32Array(weights.length)
  for (let i = 0; i < weights.length; i++) normalised[i] = weights[i] / weightSum
  return {
    offsets: new Int32Array(offsets),
    weights: normalised,
    count: weights.length,
    // One extra for the bilinear taps to the east and south.
    margin: radius + 1,
  }
}

/**
 * Bilinear height and its analytic gradient, in grid space.
 *
 * Results land in module scratch rather than a returned object. This is called
 * twice per droplet step - on the order of ten million times per island - and
 * allocating a fresh object each time is a measurable fraction of the total
 * run, all of it handed straight to the garbage collector.
 */
let sHeight = 0
let sGradX = 0
let sGradY = 0

function sampleHeightAndGradient(map: Float32Array, size: number, posX: number, posY: number): void {
  const coordX = Math.floor(posX)
  const coordY = Math.floor(posY)
  const x = posX - coordX
  const y = posY - coordY

  const i = coordY * size + coordX
  const nw = map[i]
  const ne = map[i + 1]
  const sw = map[i + size]
  const se = map[i + size + 1]

  sHeight = nw * (1 - x) * (1 - y) + ne * x * (1 - y) + sw * (1 - x) * y + se * x * y
  sGradX = (ne - nw) * (1 - y) + (se - sw) * y
  sGradY = (sw - nw) * (1 - x) + (se - ne) * x
}

export interface ErosionResult {
  field: Heightfield
  /** Wall-clock milliseconds spent in the simulation itself. */
  elapsedMs: number
  droplets: number
}

export function erodeCPU(
  field: Heightfield,
  seed: number,
  droplets = TERRAIN.dropletCount,
  lifetime = TERRAIN.dropletLifetime,
): ErosionResult {
  const start = performance.now()
  const { size } = field
  const map = field.data
  const brush = buildBrush(EROSION.erosionRadius, size)
  const rand = mulberry32(seed ^ 0x1b873593)
  const offsets = brush.offsets
  const weights = brush.weights
  const brushCount = brush.count

  // Droplets live inside this margin and retire when they leave it, which is
  // what lets the brush loop below skip a bounds check on every single cell.
  const lo = brush.margin
  const hi = size - brush.margin - 1
  const span = hi - lo

  for (let iteration = 0; iteration < droplets; iteration++) {
    let posX = lo + rand() * span
    let posY = lo + rand() * span
    let dirX = 0
    let dirY = 0
    let speed = EROSION.initialSpeed
    let water = EROSION.initialWaterVolume
    let sediment = 0

    for (let step = 0; step < lifetime; step++) {
      const nodeX = Math.floor(posX)
      const nodeY = Math.floor(posY)
      const dropletIndex = nodeY * size + nodeX
      const cellOffsetX = posX - nodeX
      const cellOffsetY = posY - nodeY

      sampleHeightAndGradient(map, size, posX, posY)
      const height = sHeight
      const gradX = sGradX
      const gradY = sGradY

      // Blend the previous direction with the downhill gradient. Inertia keeps
      // droplets from turning on the spot in flat basins.
      dirX = dirX * EROSION.inertia - gradX * (1 - EROSION.inertia)
      dirY = dirY * EROSION.inertia - gradY * (1 - EROSION.inertia)

      const len = Math.sqrt(dirX * dirX + dirY * dirY)
      if (len !== 0) {
        dirX /= len
        dirY /= len
      }
      posX += dirX
      posY += dirY

      // Retired: stationary, or walked out of the brush-safe interior.
      if ((dirX === 0 && dirY === 0) || posX < lo || posX >= hi || posY < lo || posY >= hi) {
        break
      }

      sampleHeightAndGradient(map, size, posX, posY)
      const deltaHeight = sHeight - height

      // Capacity scales with how fast the water is moving, how much of it there
      // is, and how steeply it is descending.
      const capacity = Math.max(
        -deltaHeight * speed * water * EROSION.sedimentCapacityFactor,
        EROSION.minSedimentCapacity,
      )

      if (sediment > capacity || deltaHeight > 0) {
        // Deposit. Uphill moves fill the pit the droplet just tried to climb,
        // which is what flattens basins into terraces.
        const amount = deltaHeight > 0
          ? Math.min(deltaHeight, sediment)
          : (sediment - capacity) * EROSION.depositSpeed
        sediment -= amount

        // Bilinear deposit back into the four cells under the droplet.
        map[dropletIndex] += amount * (1 - cellOffsetX) * (1 - cellOffsetY)
        map[dropletIndex + 1] += amount * cellOffsetX * (1 - cellOffsetY)
        map[dropletIndex + size] += amount * (1 - cellOffsetX) * cellOffsetY
        map[dropletIndex + size + 1] += amount * cellOffsetX * cellOffsetY
      } else {
        // Erode, spread over the brush, never taking more than the local drop.
        const amount = Math.min((capacity - sediment) * EROSION.erodeSpeed, -deltaHeight)
        // No bounds check: the droplet is inside the margin by construction.
        for (let i = 0; i < brushCount; i++) {
          const idx = dropletIndex + offsets[i]
          const weighted = amount * weights[i]
          const current = map[idx]
          const delta = current < weighted ? current : weighted
          map[idx] = current - delta
          sediment += delta
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -deltaHeight * EROSION.gravity))
      water *= 1 - EROSION.evaporateSpeed
      if (water < 0.01) break
    }
  }

  return { field, elapsedMs: performance.now() - start, droplets }
}
