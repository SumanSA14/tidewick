import type { DaylightState, RGB } from '@/core/daylight'

/**
 * Golden hour.
 *
 * Section 5: "the light on the island warms while it runs." This bends the
 * daylight state toward late-afternoon gold in proportion to how deep the
 * focus is, without touching the clock - it is still whatever hour it actually
 * is, lit as though the sun had dropped a little and turned amber.
 *
 * **It is a filter over the daylight state, not a second lighting model.** The
 * time of day, the season and the weather all still decide what the island
 * looks like; this leans on the result. A parallel "focus lighting" path would
 * be a second source of truth for the same pixels, and the two would drift the
 * first time the sky changed.
 *
 * The effect is deliberately restrained. It has to be visible - the acceptance
 * criterion says "visibly warms the light" - while remaining something you
 * notice rather than something that announces itself. A screen that goes
 * orange when you start working is a notification, not an atmosphere.
 */

/** Warm tint the light is pushed toward at full depth. */
const GOLD: RGB = { r: 1.0, g: 0.78, b: 0.46 }

/** Cooler counterpart for the sky, so the warm sun has something to sit against. */
const SKY_TINT: RGB = { r: 0.98, g: 0.80, b: 0.62 }

/** How far the sun colour can be pushed. Beyond this it reads as a filter. */
const MAX_SUN_TINT = 0.55

/** Extra sun intensity at full depth - a lift, not a floodlight. */
const MAX_INTENSITY_LIFT = 0.28

/** How far the sun is nudged toward the horizon, in normalised Y. */
const MAX_SUN_DROP = 0.14

export interface GoldenHourInput {
  /**
   * 0..1. How far into golden hour the isle is.
   *
   * Built from session progress and the warmth multiplier together: a long
   * distracted session should not look like a short focused one, because the
   * light is a record of attention and not of elapsed time.
   */
  depth: number
}

/**
 * How golden the light should be right now.
 *
 * Ramps in over the first stretch of a session rather than snapping on, so
 * starting a timer does not visibly change the screen - by the time you notice,
 * it already happened.
 */
export function goldenDepth(progress: number, warmth: number, warmthBase = 1): number {
  if (progress <= 0) return 0
  // Ease in over the first third: the change should be underway before it is
  // perceptible.
  const ramp = Math.min(1, progress / 0.33)
  const eased = ramp * ramp * (3 - 2 * ramp)
  // Attention decides the ceiling. A session spent in another window warms the
  // light barely at all, which is the honest outcome.
  const attention = Math.max(0, Math.min(1.2, warmth / Math.max(0.001, warmthBase)))
  return Math.max(0, Math.min(1, eased * attention))
}

/**
 * Apply golden hour to a daylight state.
 *
 * Returns a new state; the caller keeps the unlit original so the effect can be
 * removed without recomputing the hour.
 */
export function applyGoldenHour(state: DaylightState, depth: number): DaylightState {
  const t = Math.max(0, Math.min(1, depth))
  if (t <= 0) return state

  const d = state.sunDirection
  // Drop the sun toward the horizon, then renormalise: a raking light is what
  // actually makes the terraces read, and it is what "golden hour" means.
  const y = Math.max(0.08, d.y - MAX_SUN_DROP * t)
  const length = Math.hypot(d.x, y, d.z) || 1

  return {
    ...state,
    sun: mix(state.sun, GOLD, MAX_SUN_TINT * t),
    glow: mix(state.glow, GOLD, 0.45 * t),
    skyHorizon: mix(state.skyHorizon, SKY_TINT, 0.34 * t),
    // The ambient bounce warms less than the key light. Warming both equally
    // washes the scene flat, because the contrast between them is the effect.
    ambient: mix(state.ambient, GOLD, 0.20 * t),
    sunIntensity: state.sunIntensity * (1 + MAX_INTENSITY_LIFT * t),
    sunDirection: { x: d.x / length, y: y / length, z: d.z / length },
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}
