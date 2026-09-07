import { uniform, time } from 'three/tsl'

/**
 * One clock for every idle animation on the isle.
 *
 * Grass wind, the sea's swell, the twinkle of the stars and the drift of the
 * clouds all read `motionTime` instead of TSL's `time`. It is the same clock
 * multiplied by one uniform, so `prefers-reduced-motion` can bring every idle
 * animation to a standstill at once - and at zero, not at whatever phase the
 * frame happened to be on, so the still picture is the *rest* picture.
 *
 * Nothing that carries meaning reads this clock. A plant still drifts downhill
 * as its due date approaches, a lantern still blooms when a task completes,
 * the sun still moves with the real time of day. Reduced motion removes the
 * decoration, never the information.
 */
export const uMotion = uniform(1)
export const motionTime = time.mul(uMotion)

export function setMotionScale(scale: number): void {
  uMotion.value = Math.max(0, Math.min(1, scale))
}

/**
 * How many flocking agents to spawn for a tier when motion is reduced.
 *
 * The brief asks reduced motion to "cut particle density". The birds are the
 * only particles the isle has, and they are also part of what makes it feel
 * inhabited, so they are thinned rather than removed: a third of the budget,
 * never fewer than a handful, never zero unless the tier itself is zero.
 */
export function agentsFor(budget: number, reducedMotion: boolean): number {
  if (!reducedMotion || budget === 0) return budget
  return Math.max(24, Math.floor(budget / 3))
}
