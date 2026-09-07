import type { QualityTier } from './config'
import type { DeviceSettings } from './settings'

/**
 * The first-run quality benchmark's decision rule.
 *
 * Section 15 asks for the tier to be auto-detected "with a short benchmark",
 * and the adapter heuristic in `render/capability.ts` is only a starting
 * point. Once the isle is up, the app measures presented frames and calls this
 * with the median. The rule is deliberately one-directional and small:
 *
 *   1. Inside the budget: stop. Nothing is ever stepped *up* automatically -
 *      a machine that comfortably runs Medium is not promoted to High behind
 *      the person's back, because High costs memory and startup time too.
 *   2. Over budget with a lower render scale available: take it and measure
 *      again. Scale is tried before tier because it keeps the tier's content
 *      (the 250k blades, the ink) and changes only how many pixels draw it.
 *   3. Over budget at the smallest scale: the tier below, at full scale, from
 *      the next start. Tiers size buffers at construction, so that needs a
 *      restart; the scale steps do not.
 *   4. Already Low and still over: this is what the machine can do. Stop.
 *
 * Measured on Intel Iris Xe at 1920x1080, Medium: 33 ms at 1.0, 25 ms at
 * 0.85, 16.8 ms at 0.75 - three calls, done.
 */

export const FRAME_BUDGET_MS = 1000 / 60

/**
 * A 120 Hz panel quantises presented frames to 8.3 ms steps, so a frame that
 * fits 60 fps reads as 16.7 or, on a slow one, 25. Anything up to ~18.7 is
 * taken as fitting.
 */
export const BUDGET_TOLERANCE = 1.12

export const SCALE_STEPS: readonly number[] = [1, 0.85, 0.75, 0.66]

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra']

export interface QualityStep {
  renderScale: number
  tier: QualityTier
  /** True when there is nothing more to try this session. */
  done: boolean
}

/**
 * A tier demotion needs two starts to agree.
 *
 * Found the hard way: the desktop build's first run measured while another
 * instance of the app was rendering on the same integrated GPU, missed the
 * budget at every scale, and demoted itself to Low on that one reading. A GPU
 * shared with something else for ten seconds is indistinguishable from a slow
 * one inside a single benchmark, so one miss at the smallest scale is a strike,
 * not a verdict: keep the smallest scale for this session, measure again next
 * start, and demote only when the second start agrees. A fit at any scale
 * clears the strikes.
 */
export const DEMOTION_STRIKES = 2

export function applyBenchmarkOutcome(settings: DeviceSettings, outcome: QualityStep, currentTier: QualityTier): DeviceSettings {
  const demoted = outcome.tier !== currentTier
  if (!demoted) {
    return { ...settings, renderScale: outcome.renderScale, demotionStrikes: 0, benchmarked: true }
  }
  const strikes = settings.demotionStrikes + 1
  if (strikes < DEMOTION_STRIKES) {
    return { ...settings, renderScale: SCALE_STEPS[SCALE_STEPS.length - 1], demotionStrikes: strikes, benchmarked: false }
  }
  // Confirmed. The new tier starts at full scale and is measured on the next
  // start; Low is the floor and is accepted as it is.
  return { ...settings, renderScale: 1, autoTier: outcome.tier, demotionStrikes: 0, benchmarked: outcome.tier === 'low' }
}

export function nextQualityStep(medianFrameMs: number, tier: QualityTier, renderScale: number): QualityStep {
  if (!Number.isFinite(medianFrameMs) || medianFrameMs <= FRAME_BUDGET_MS * BUDGET_TOLERANCE) {
    return { renderScale, tier, done: true }
  }
  const lower = SCALE_STEPS.filter((s) => s < renderScale - 1e-6)
  if (lower.length > 0) return { renderScale: lower[0], tier, done: false }
  const below = ORDER[ORDER.indexOf(tier) - 1]
  if (!below) return { renderScale, tier, done: true }
  return { renderScale: 1, tier: below, done: true }
}
