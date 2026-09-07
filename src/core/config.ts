/**
 * Tunable constants for Tidewick.
 *
 * Section 19 of the brief calls the elevation horizon "the single number that
 * sets the emotional temperature of the whole app". It lives here, alone,
 * so that changing the feel of the product is a one-line edit and not an
 * archaeology expedition.
 */

/** Days from the misty peaks down to the waterline. Shorter = steeper = more urgent. */
export const ELEVATION_HORIZON_DAYS = 90

/** Length of one work cycle, which is one season on the island. */
export const SEASON_LENGTH_DAYS = 14

/** Default focus session length in minutes. The only source of Sunlight. */
export const FOCUS_SESSION_MINUTES = 25

/** Simulation runs at a fixed rate, decoupled from display refresh. */
export const SIM_HZ = 60
export const SIM_STEP_MS = 1000 / SIM_HZ

/** Never advance more than this much simulated time in one frame (spiral-of-death guard). */
export const MAX_FRAME_MS = 250

export interface TerrainConfig {
  gridSize: number
  worldSize: number
  terraceBands: number
  terraceSmoothing: number
  terraceGrid: number
  peakHeight: number
  seaLevel: number
  dropletCount: number
  dropletLifetime: number
}

export const TERRAIN: TerrainConfig = {
  /** Heightfield resolution. 256 gives plateaus that read well at diorama distance. */
  gridSize: 256,
  /** World-space extent of the heightfield, in metres. */
  worldSize: 220,
  /** Number of discrete terrace bands between sea level and the peak. */
  terraceBands: 12,
  /** Blur passes before quantising. This is the plateau-width dial. */
  terraceSmoothing: 4,
  /** Resolution the terraces are meshed at. Lower = chunkier plateaus. */
  terraceGrid: 104,
  /**
   * Height of the tallest peak, in metres.
   *
   * Set by the *step aspect ratio*, not by taste. A band is
   * peakHeight / (terraceBands - 1) tall and a plateau is some number of
   * cellSize wide; when the step is taller than it is wide the island becomes a
   * staircase steeper than 45 degrees, every step drops its neighbour into full
   * shadow, and the terraces read as dark corrugation instead of as plateaus.
   * At 24 m over 12 bands each step is ~2.2 m against a 2.1 m cell, which keeps
   * risers shorter than treads once smoothing has widened the plateaus.
   */
  peakHeight: 24,
  /** World-space Y of the waterline. Terrain below this is shallows. */
  seaLevel: 0,
  /**
   * Droplets per erosion run. Iteration count is what makes this GPU-bound.
   *
   * This number is set by what the *CPU* fallback can afford inside the 400 ms
   * budget, not by what the GPU could manage - deliberately, because the two
   * paths must carve the identical island or the claim that the same workspace
   * always grows the same isle is only true per-device. What the GPU buys is
   * therefore headroom to re-erode often, not a different terrain.
   */
  dropletCount: 65_000,
  /** Maximum steps a single droplet may take before it is retired. */
  dropletLifetime: 36,
}

export interface ErosionConfig {
  inertia: number
  sedimentCapacityFactor: number
  minSedimentCapacity: number
  erodeSpeed: number
  depositSpeed: number
  evaporateSpeed: number
  gravity: number
  erosionRadius: number
  initialWaterVolume: number
  initialSpeed: number
}

export const EROSION: ErosionConfig = {
  inertia: 0.045,
  sedimentCapacityFactor: 3.6,
  minSedimentCapacity: 0.008,
  erodeSpeed: 0.32,
  depositSpeed: 0.32,
  evaporateSpeed: 0.022,
  gravity: 4.0,
  erosionRadius: 2,
  initialWaterVolume: 1.0,
  initialSpeed: 1.0,
}

/** Quality tiers. Auto-detected on first run, manually overridable. */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra'

export interface TierBudget {
  grass: number
  agents: number
  shadowSize: number
  /**
   * Erosion droplets on the CPU path.
   *
   * Measured in the browser worker, 65k droplets cost 283-324 ms cold - which
   * with base generation and meshing lands at 387-453 ms against a 400 ms
   * budget. The brush optimisation bought less than 10%: a fresh worker runs
   * cold, and the per-step sampling dominates. So the count is a tier
   * decision. Measured with a warmed worker, 48k came in at 306-378 ms and a
   * cold first run at 443; 40k carves a recognisably eroded island and puts
   * the cold run at the budget. The high tiers keep the full count and accept
   * the time.
   */
  droplets: number
  /** Post-process bloom strength; zero disables the pass entirely. */
  bloom: number
  /**
   * Volumetric god-rays strength; zero builds no raymarch pass at all.
   *
   * Zero at every tier, on purpose. The pass is written, compiles on WebGL2,
   * and was measured adding light (mean luminance +22% at strength 0.5,
   * pixel readback) - and then looked at. Crepuscular rays are shadow
   * streaks in lit haze, so they need tall occluders between the camera and
   * the sun. This isle is a low, open place: a few trees, grass that casts
   * no shadow, terraces a couple of metres tall. From the diorama the march
   * is lit end to end and the result is a grey veil over the whole picture;
   * at the Keeper's eye level toward the sun it is the same veil with a
   * brighter sky. Left in the code because the seam is small and honest;
   * turned on nowhere because it made the isle worse everywhere it was tried.
   */
  godrays: number
  /**
   * Whether the outline pass renders a view-normal target alongside colour.
   * The normal term of the ink is deliberately faint (see `passes/outline.ts`),
   * and the extra full-resolution target is a measurable cost on integrated
   * GPUs, so the low tiers ink from depth alone.
   */
  outlineNormals: boolean
}

/**
 * Agent counts are what is *drawn*, and they are small on purpose.
 *
 * The brief's 50k figure is a compute-showcase number. The first build drew
 * the Medium budget of 10,000 birds over a 220-unit island seen from 300 units
 * away, and the result was a dense black ring of locusts that hid the isle. A
 * flock you would want over a place you go to be calm is a few hundred birds.
 * The CPU simulation handles 10k comfortably at 30 Hz - that is measured, not
 * inferred - but nothing in this product is improved by drawing them.
 */
export const TIER_BUDGETS: Record<QualityTier, TierBudget> = {
  low: { grass: 0, agents: 120, shadowSize: 1024, droplets: 30_000, bloom: 0, godrays: 0, outlineNormals: false },
  // Medium is the tier the 60 fps budget names, and it was tuned against the
  // budget's own hardware (Intel Iris Xe, 1920x1080, WebGPU): depth-only ink
  // saved 9 ms of GPU, no bloom 8 ms of frame, the 1024 shadow map about one;
  // with those and a 75% render scale it presents at 16.8 ms. Bloom on top
  // costs the frame (25 ms), so the glow is High's.
  medium: { grass: 250_000, agents: 260, shadowSize: 1024, droplets: 40_000, bloom: 0, godrays: 0, outlineNormals: false },
  high: { grass: 1_000_000, agents: 900, shadowSize: 2048, droplets: 65_000, bloom: 0.5, godrays: 0, outlineNormals: true },
  ultra: { grass: 2_000_000, agents: 1_600, shadowSize: 4096, droplets: 90_000, bloom: 0.6, godrays: 0, outlineNormals: true },
}

/**
 * Development-only tuning from the URL, so a tier's knobs can be A/B'd by
 * reload against a real GPU without editing this file between runs:
 *
 *   ?budget.bloom=0&budget.shadowSize=1024&budget.grass=125000&budget.outlineNormals=0
 *
 * Production builds ignore the query entirely; the tiers above are the product.
 */
export function devOverrides(): Record<string, string> {
  if (!import.meta.env.DEV || typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = v
  return out
}

/** The tier's budget, with any development overrides applied. */
export function budgetFor(tier: QualityTier, overrides: Record<string, string> = devOverrides()): TierBudget {
  const base = TIER_BUDGETS[tier]
  const merged: Record<string, number | boolean> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith('budget.')) continue
    const field = key.slice('budget.'.length) as keyof TierBudget
    if (!(field in base)) continue
    merged[field] = typeof base[field] === 'boolean' ? value !== '0' && value !== 'false' : Number(value)
  }
  return merged as unknown as TierBudget
}
