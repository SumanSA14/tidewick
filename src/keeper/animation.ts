import { KEEPER, speedOf, type KeeperState } from './controller'

/**
 * The Keeper's animation state machine.
 *
 * Six states, per Section 10: idle, walk, run, tend, carry, sit. The machine
 * itself is pure - it takes the controller state and what the Keeper is doing,
 * and returns a state plus a blend weight - so the transitions can be tested
 * without a renderer, a model, or a clock.
 *
 * **What is missing, plainly:** there is no rigged character and no animation
 * clips. This project has no art pipeline, so `render/keeper.ts` drives a
 * procedural pose from these outputs instead - a walk cycle computed from a
 * phase, not sampled from a curve. The state machine, the transitions and the
 * blend weights are the parts that would survive; swapping in real clips means
 * replacing the pose function and nothing else.
 */

export type KeeperAnimation = 'idle' | 'walk' | 'run' | 'tend' | 'carry' | 'sit'

export interface KeeperActivity {
  /** Holding a plant, on the way back up the slope. */
  carrying: boolean
  /** Mid-tend. Set for the length of the action, then cleared. */
  tending: boolean
  /** Idle long enough to have sat down. */
  resting: boolean
}

export interface AnimationState {
  current: KeeperAnimation
  previous: KeeperAnimation
  /** 0..1 across the crossfade from `previous` to `current`. */
  blend: number
  /** Seconds in the current state. Drives the procedural pose phase. */
  elapsed: number
  /** Distance travelled, so a walk cycle is tied to the ground not the clock. */
  stride: number
}

/** Crossfade length. Long enough to read, short enough not to feel laggy. */
const BLEND_SECONDS = 0.18

/** Below this speed the Keeper is standing still. */
const IDLE_SPEED = 0.35

/** Seconds of stillness before the Keeper sits down. */
export const SIT_AFTER_SECONDS = 12

export function createAnimation(): AnimationState {
  return { current: 'idle', previous: 'idle', blend: 1, elapsed: 0, stride: 0 }
}

/**
 * Pick the state for this frame and advance the blend.
 *
 * Priority order matters and is not arbitrary: tending is a deliberate action
 * and outranks everything, carrying changes the whole silhouette so it outranks
 * gait, and sitting only wins when nothing else is happening at all.
 */
export function stepAnimation(
  animation: AnimationState,
  keeper: KeeperState,
  activity: KeeperActivity,
  dt: number,
): AnimationState {
  const speed = speedOf(keeper)
  const moving = speed > IDLE_SPEED

  let next: KeeperAnimation
  if (activity.tending) next = 'tend'
  else if (activity.carrying) next = 'carry'
  else if (moving) next = speed > KEEPER.walkSpeed * 1.15 ? 'run' : 'walk'
  else if (activity.resting) next = 'sit'
  else next = 'idle'

  if (next !== animation.current) {
    animation.previous = animation.current
    animation.current = next
    // Restart the fade from wherever the last one got to, so rapid changes
    // do not pop back to zero and stutter.
    animation.blend = 0
    animation.elapsed = 0
  }

  animation.blend = Math.min(1, animation.blend + dt / BLEND_SECONDS)
  animation.elapsed += dt
  // Stride advances with distance, not time: a Keeper walking slowly should
  // take slow steps, and one standing still should not moonwalk on the spot.
  animation.stride += speed * dt

  return animation
}

export interface KeeperPose {
  /** Vertical bob, in world units. */
  bob: number
  /** Lean into the direction of travel, radians. */
  lean: number
  /** Arm swing, radians. Opposed left and right. */
  armSwing: number
  /** Leg swing, radians. */
  legSwing: number
  /** How far the Keeper is crouched, 0..1. */
  crouch: number
  /** Arms raised to hold something, 0..1. */
  hold: number
}

const REST: KeeperPose = { bob: 0, lean: 0, armSwing: 0, legSwing: 0, crouch: 0, hold: 0 }

/**
 * The procedural pose for one animation state.
 *
 * Stands in for a sampled clip. Everything is a function of the stride phase
 * rather than of elapsed time, so the feet keep pace with the ground.
 */
export function poseFor(state: KeeperAnimation, animation: AnimationState): KeeperPose {
  const phase = animation.stride * 0.55
  const t = animation.elapsed

  switch (state) {
    case 'walk':
      return {
        bob: Math.abs(Math.sin(phase)) * 0.18,
        lean: 0.06,
        armSwing: Math.sin(phase) * 0.55,
        legSwing: Math.sin(phase) * 0.7,
        crouch: 0,
        hold: 0,
      }
    case 'run':
      return {
        bob: Math.abs(Math.sin(phase)) * 0.3,
        lean: 0.2,
        armSwing: Math.sin(phase) * 0.9,
        legSwing: Math.sin(phase) * 1.15,
        crouch: 0.08,
        hold: 0,
      }
    case 'carry':
      return {
        bob: Math.abs(Math.sin(phase)) * 0.12,
        lean: -0.08,
        armSwing: 0,
        legSwing: Math.sin(phase) * 0.5,
        crouch: 0.12,
        hold: 1,
      }
    case 'tend':
      // A single unhurried crouch and reach. Section 11: one satisfying
      // sequence, no confetti.
      return {
        bob: 0,
        lean: 0.35,
        armSwing: Math.sin(t * 4) * 0.25,
        legSwing: 0,
        crouch: 0.7,
        hold: 0.3,
      }
    case 'sit':
      return {
        bob: Math.sin(t * 0.9) * 0.03,
        lean: 0.12,
        armSwing: 0,
        legSwing: 0,
        crouch: 1,
        hold: 0,
      }
    default:
      return {
        // Breathing. The difference between a character and a statue.
        bob: Math.sin(t * 1.4) * 0.045,
        lean: 0,
        armSwing: Math.sin(t * 1.4) * 0.05,
        legSwing: 0,
        crouch: 0,
        hold: 0,
      }
  }
}

/** The blended pose: what the renderer actually draws. */
export function blendedPose(animation: AnimationState): KeeperPose {
  const to = poseFor(animation.current, animation)
  if (animation.blend >= 1) return to
  const from = poseFor(animation.previous, animation)
  return mixPose(from, to, easeInOut(animation.blend))
}

function mixPose(a: KeeperPose, b: KeeperPose, t: number): KeeperPose {
  return {
    bob: lerp(a.bob, b.bob, t),
    lean: lerp(a.lean, b.lean, t),
    armSwing: lerp(a.armSwing, b.armSwing, t),
    legSwing: lerp(a.legSwing, b.legSwing, t),
    crouch: lerp(a.crouch, b.crouch, t),
    hold: lerp(a.hold, b.hold, t),
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

export { REST as RESTING_POSE }
