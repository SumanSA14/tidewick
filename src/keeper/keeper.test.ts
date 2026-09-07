import { describe, it, expect, beforeEach } from 'vitest'
import {
  createKeeper, stepKeeper, speedOf, turnToward, normaliseAngle,
  KEEPER, WATER_LEVEL, type GroundSampler, type KeeperInput, type KeeperState,
} from './controller'
import {
  createAnimation, stepAnimation, blendedPose, poseFor, SIT_AFTER_SECONDS,
} from './animation'
import {
  dueDateForPosition, actionFor, promptFor, REACH, nearestInteractable, plantPosition,
} from './interaction'
import { buildRadialProfile } from '@/render/terrain/profile'
import { terrace } from '@/render/terrain/terrace'
import { generateBaseHeightfield, downsample, normalise, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { terrainSeed } from '@/core/hash'
import { TERRAIN, ELEVATION_HORIZON_DAYS } from '@/core/config'
import { EMPTY_SNAPSHOT, MS_PER_DAY, STAGE, type IslandSnapshot } from '@/island/derive'

/**
 * The Keeper.
 *
 * The controller is tested against synthetic terrain rather than the real
 * island, because "can you walk up this" is a question about a specific slope,
 * and a hand-built hillside makes the failure legible when it fails.
 */

/** A flat plain of a given height, land everywhere. */
function flat(height = 0): GroundSampler {
  return { heightAt: () => height, isLand: () => true }
}

/** A staircase rising along +X, one step every `run` units. */
function stairs(rise: number, run = 4): GroundSampler {
  return {
    heightAt: (x) => Math.max(0, Math.floor(x / run) * rise),
    isLand: () => true,
  }
}

/** Land inside a radius, open sea beyond it. */
function island(radius = 40, height = 5): GroundSampler {
  return {
    heightAt: (x, z) => (Math.hypot(x, z) < radius ? height : WATER_LEVEL - 4),
    isLand: (x, z) => Math.hypot(x, z) < radius,
  }
}

const NO_INPUT: KeeperInput = { strafe: 0, forward: 0, cameraYaw: 0, run: false, jump: false }
const FORWARD: KeeperInput = { ...NO_INPUT, forward: 1 }

/** Run the controller for a while at a fixed 60 Hz. */
function simulate(state: KeeperState, input: KeeperInput, sampler: GroundSampler, seconds: number) {
  const dt = 1 / 60
  for (let i = 0; i < Math.round(seconds / dt); i++) stepKeeper(state, input, sampler, dt)
  return state
}

describe('controller', () => {
  it('starts standing on the ground', () => {
    const keeper = createKeeper(0, 0, flat(7))
    expect(keeper.y).toBe(7)
    expect(keeper.grounded).toBe(true)
  })

  it('accelerates rather than snapping to full speed', () => {
    const keeper = createKeeper(0, 0, flat())
    stepKeeper(keeper, FORWARD, flat(), 1 / 60)
    const afterOneFrame = speedOf(keeper)
    expect(afterOneFrame).toBeGreaterThan(0)
    // Weight: one frame must not reach walking pace.
    expect(afterOneFrame).toBeLessThan(KEEPER.walkSpeed * 0.5)
  })

  it('reaches walking speed and stops there', () => {
    const keeper = simulate(createKeeper(0, 0, flat()), FORWARD, flat(), 2)
    expect(speedOf(keeper)).toBeCloseTo(KEEPER.walkSpeed, 0)
  })

  it('runs faster than it walks', () => {
    const walk = simulate(createKeeper(0, 0, flat()), FORWARD, flat(), 2)
    const run = simulate(createKeeper(0, 0, flat()), { ...FORWARD, run: true }, flat(), 2)
    expect(speedOf(run)).toBeGreaterThan(speedOf(walk) * 1.4)
  })

  it('comes to a stop when input stops', () => {
    const keeper = simulate(createKeeper(0, 0, flat()), FORWARD, flat(), 1)
    simulate(keeper, NO_INPUT, flat(), 1)
    expect(speedOf(keeper)).toBeCloseTo(0, 3)
  })

  it('moves relative to the camera, not to the world', () => {
    const east = simulate(createKeeper(0, 0, flat()), { ...FORWARD, cameraYaw: Math.PI / 2 }, flat(), 1)
    const north = simulate(createKeeper(0, 0, flat()), FORWARD, flat(), 1)
    // Same key, different camera, different direction - anything else and the
    // controls fight the camera.
    expect(Math.abs(east.x)).toBeGreaterThan(Math.abs(east.z))
    expect(Math.abs(north.z)).toBeGreaterThan(Math.abs(north.x))
  })

  describe('terraces', () => {
    it('climbs a step within the offset', () => {
      const ground = stairs(KEEPER.stepOffset * 0.7)
      const keeper = simulate(createKeeper(0, 0, ground), { ...FORWARD, cameraYaw: Math.PI / 2 }, ground, 3)
      expect(keeper.x).toBeGreaterThan(8)
      expect(keeper.y).toBeGreaterThan(0)
    })

    it('is stopped by a step taller than the offset', () => {
      const wall = stairs(KEEPER.stepOffset * 3)
      const keeper = simulate(createKeeper(0, 0, wall), { ...FORWARD, cameraYaw: Math.PI / 2 }, wall, 3)
      // Blocked at the first riser rather than climbing a cliff.
      expect(keeper.x).toBeLessThan(4 + KEEPER.radius + 0.5)
    })

    it('slides along a cliff instead of stopping dead', () => {
      // Walking at a wall diagonally must keep the along-wall component. A
      // controller that zeroes both axes feels stuck even when it is not.
      const wall: GroundSampler = {
        heightAt: (x) => (x > 6 ? 40 : 0),
        isLand: () => true,
      }
      const keeper = createKeeper(0, 0, wall)
      // Push north-east: +X is into the wall, +Z is along it.
      simulate(keeper, { ...FORWARD, strafe: 1, cameraYaw: Math.PI / 2 }, wall, 2)
      expect(keeper.x).toBeLessThan(6)
      expect(Math.abs(keeper.z)).toBeGreaterThan(5)
    })

    it('crosses real terraced terrain without producing garbage', () => {
      // Whether the isle is *connected* is answered properly in
      // reachability.test.ts; what a walk can prove is that the controller
      // stays numerically sane on real ground.
      const seed = terrainSeed('first-isle')
      const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
      const coarse = downsample(field, 72)
      const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
      const terraced = terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)

      const sampler: GroundSampler = {
        heightAt: (x, z) => groundOf(terraced, x, z),
        isLand: (x, z) => landAt(terraced, x, z),
      }

      for (let i = 0; i < 16; i++) {
        const yaw = (i / 16) * Math.PI * 2
        const keeper = createKeeper(0, 0, sampler)
        simulate(keeper, { ...FORWARD, cameraYaw: yaw, run: true }, sampler, 6)
        expect(Number.isFinite(keeper.x)).toBe(true)
        expect(Number.isFinite(keeper.y)).toBe(true)
        expect(Number.isFinite(keeper.z)).toBe(true)
        // Never underneath the terrain, never launched off it.
        expect(keeper.y).toBeGreaterThanOrEqual(WATER_LEVEL - KEEPER.wadeDepth - 0.01)
        expect(keeper.y).toBeLessThanOrEqual(TERRAIN.peakHeight + 1)
      }
    })

    it('descends from the summit under gravity without floating', () => {
      const seed = terrainSeed('first-isle')
      const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
      const coarse = downsample(field, 72)
      const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
      const terraced = terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
      const sampler: GroundSampler = {
        heightAt: (x, z) => groundOf(terraced, x, z),
        isLand: (x, z) => landAt(terraced, x, z),
      }

      const keeper = createKeeper(0, 0, sampler)
      const startHeight = keeper.y
      simulate(keeper, { ...FORWARD, cameraYaw: 0, run: true }, sampler, 6)
      // Downhill from the peak: ends lower, and standing on the ground.
      expect(keeper.y).toBeLessThan(startHeight)
      expect(keeper.grounded).toBe(true)
      expect(keeper.y).toBeCloseTo(groundOf(terraced, keeper.x, keeper.z), 1)
    })
  })

  describe('water', () => {
    it('wades in the shallows, more slowly', () => {
      const ground = island(10, 2)
      const keeper = createKeeper(0, 0, ground)
      simulate(keeper, { ...FORWARD, cameraYaw: Math.PI / 2, run: true }, ground, 4)
      expect(keeper.wading).toBe(true)
      // Wading is deliberate, which is what makes beachcombing feel like an act.
      expect(speedOf(keeper)).toBeLessThan(KEEPER.walkSpeed)
    })

    it('can always get back to shore once out at sea', () => {
      const ground = island(10, 2)
      const keeper = createKeeper(0, 0, ground)
      simulate(keeper, { ...FORWARD, cameraYaw: Math.PI / 2 }, ground, 4)
      const wentOut = keeper.x
      simulate(keeper, { ...FORWARD, cameraYaw: -Math.PI / 2 }, ground, 4)
      // Refusing to enter deep water must never become a trap.
      expect(keeper.x).toBeLessThan(wentOut)
    })

    it('never falls through the world', () => {
      const ground = island(10, 2)
      const keeper = createKeeper(0, 0, ground)
      simulate(keeper, { ...FORWARD, cameraYaw: Math.PI / 2 }, ground, 20)
      expect(keeper.y).toBeGreaterThan(WATER_LEVEL - KEEPER.wadeDepth - 0.01)
    })
  })

  describe('jumping', () => {
    it('leaves the ground and lands again', () => {
      const keeper = createKeeper(0, 0, flat())
      stepKeeper(keeper, { ...NO_INPUT, jump: true }, flat(), 1 / 60)
      expect(keeper.grounded).toBe(false)
      simulate(keeper, NO_INPUT, flat(), 2)
      expect(keeper.grounded).toBe(true)
      expect(keeper.y).toBeCloseTo(0, 3)
    })

    it('allows a jump just after walking off an edge', () => {
      const keeper = createKeeper(0, 0, flat())
      keeper.grounded = false
      keeper.airborne = KEEPER.coyoteTime * 0.5
      stepKeeper(keeper, { ...NO_INPUT, jump: true }, flat(), 1 / 60)
      expect(keeper.velocityY).toBeGreaterThan(0)
    })

    it('refuses a second jump from the same coyote window', () => {
      const keeper = createKeeper(0, 0, flat())
      keeper.grounded = false
      keeper.airborne = KEEPER.coyoteTime * 0.5
      stepKeeper(keeper, { ...NO_INPUT, jump: true }, flat(), 1 / 60)
      const first = keeper.velocityY
      stepKeeper(keeper, { ...NO_INPUT, jump: true }, flat(), 1 / 60)
      expect(keeper.velocityY).toBeLessThan(first)
    })
  })

  describe('facing', () => {
    it('turns toward travel rather than snapping', () => {
      const keeper = createKeeper(0, 0, flat())
      keeper.yaw = 0
      stepKeeper(keeper, { ...FORWARD, cameraYaw: Math.PI }, flat(), 1 / 60)
      stepKeeper(keeper, { ...FORWARD, cameraYaw: Math.PI }, flat(), 1 / 60)
      expect(keeper.yaw).not.toBeCloseTo(Math.PI, 1)
    })

    it('takes the short way round', () => {
      expect(turnToward(0.1, Math.PI * 2 - 0.1, 1)).toBeCloseTo(Math.PI * 2 - 0.1, 5)
      expect(normaliseAngle(-0.5)).toBeCloseTo(Math.PI * 2 - 0.5, 5)
    })
  })
})

describe('animation state machine', () => {
  let animation = createAnimation()
  const idleKeeper = () => createKeeper(0, 0, flat())
  const still = { carrying: false, tending: false, resting: false }

  beforeEach(() => { animation = createAnimation() })

  it('starts idle', () => {
    expect(animation.current).toBe('idle')
  })

  it('walks when moving and runs when moving fast', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.walkSpeed
    stepAnimation(animation, keeper, still, 1 / 60)
    expect(animation.current).toBe('walk')

    keeper.velocityX = KEEPER.runSpeed
    stepAnimation(animation, keeper, still, 1 / 60)
    expect(animation.current).toBe('run')
  })

  it('lets tending outrank everything', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.runSpeed
    stepAnimation(animation, keeper, { carrying: true, tending: true, resting: false }, 1 / 60)
    expect(animation.current).toBe('tend')
  })

  it('lets carrying outrank gait', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.runSpeed
    stepAnimation(animation, keeper, { ...still, carrying: true }, 1 / 60)
    expect(animation.current).toBe('carry')
  })

  it('sits only when nothing else is happening', () => {
    stepAnimation(animation, idleKeeper(), { ...still, resting: true }, 1 / 60)
    expect(animation.current).toBe('sit')
  })

  it('crossfades rather than cutting', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.walkSpeed
    stepAnimation(animation, keeper, still, 1 / 120)
    expect(animation.blend).toBeGreaterThan(0)
    expect(animation.blend).toBeLessThan(1)
    expect(animation.previous).toBe('idle')
    expect(animation.current).toBe('walk')
  })

  it('completes the blend and stays there', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.walkSpeed
    for (let i = 0; i < 60; i++) stepAnimation(animation, keeper, still, 1 / 60)
    expect(animation.blend).toBe(1)
  })

  it('ties the stride to distance, not to time', () => {
    const moving = idleKeeper()
    moving.velocityX = KEEPER.walkSpeed
    stepAnimation(animation, moving, still, 1)
    const walked = animation.stride

    const stopped = createAnimation()
    stepAnimation(stopped, idleKeeper(), still, 1)
    // Standing still must not moonwalk on the spot.
    expect(walked).toBeGreaterThan(0)
    expect(stopped.stride).toBe(0)
  })

  it('produces a finite pose in every state', () => {
    for (const state of ['idle', 'walk', 'run', 'tend', 'carry', 'sit'] as const) {
      const pose = poseFor(state, { ...animation, current: state, elapsed: 1.3, stride: 7 })
      for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('blends between two poses partway through a transition', () => {
    const keeper = idleKeeper()
    keeper.velocityX = KEEPER.walkSpeed
    stepAnimation(animation, keeper, still, 1 / 240)
    const pose = blendedPose(animation)
    expect(Number.isFinite(pose.armSwing)).toBe(true)
  })

  it('breathes when idle, so it is not a statue', () => {
    const a = poseFor('idle', { ...animation, elapsed: 0.2 })
    const b = poseFor('idle', { ...animation, elapsed: 1.6 })
    expect(a.bob).not.toBe(b.bob)
  })

  it('has a sensible rest threshold', () => {
    expect(SIT_AFTER_SECONDS).toBeGreaterThan(5)
  })
})

describe('interaction', () => {
  const seed = terrainSeed('first-isle')
  const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(field, 72)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
  const terraced = terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
  const profile = buildRadialProfile(terraced, 32, 24)
  const now = Date.UTC(2026, 2, 1, 12)

  describe('the context action', () => {
    it('offers nothing when nothing is in reach', () => {
      expect(actionFor(null, null)).toBe('none')
    })

    it('offers to tend an unfinished plant', () => {
      expect(actionFor(reachable({ beachcombable: false, finished: false }), null)).toBe('tend')
    })

    it('offers to lift an overdue plant out of the shallows', () => {
      expect(actionFor(reachable({ beachcombable: true, finished: false }), null)).toBe('pick-up')
    })

    it('offers nothing on finished work', () => {
      expect(actionFor(reachable({ beachcombable: false, finished: true }), null)).toBe('none')
    })

    it('always offers to set down what is being carried', () => {
      expect(actionFor(null, 'page-1')).toBe('put-down')
      expect(actionFor(reachable({ beachcombable: true, finished: false }), 'page-1')).toBe('put-down')
    })

    it('says what will happen, rather than listing options', () => {
      expect(promptFor('tend', 'Two Sum')).toContain('Two Sum')
      expect(promptFor('pick-up', 'Two Sum')).toContain('shallows')
      expect(promptFor('none', 'Two Sum')).toBe('')
    })
  })

  describe('beachcombing: position back to a date', () => {
    it('gives a date further out the higher up the slope you stand', () => {
      const shore = dueDateForPosition(profile.maxRadius[0] * 0.95, 0, profile, now)
      const inland = dueDateForPosition(profile.maxRadius[0] * 0.3, 0, profile, now)
      expect(inland).toBeGreaterThan(shore)
    })

    it('never hands back a date that is already overdue', () => {
      // Rescuing a plant and having it be late again on the spot would be a
      // small cruelty. Section 3.3: rescue, not failure.
      for (let r = 0; r < profile.maxRadius[0]; r += 4) {
        expect(dueDateForPosition(r, 0, profile, now)).toBeGreaterThan(now)
      }
    })

    it('stays inside the horizon', () => {
      const atPeak = dueDateForPosition(0, 0, profile, now)
      const daysOut = (atPeak - now) / MS_PER_DAY
      expect(daysOut).toBeLessThanOrEqual(ELEVATION_HORIZON_DAYS + 1)
    })

    it('rounds to a whole day', () => {
      const due = dueDateForPosition(30, 10, profile, now)
      const d = new Date(due)
      expect(d.getHours()).toBe(0)
      expect(d.getMinutes()).toBe(0)
    })
  })

  describe('reach', () => {
    it('finds nothing on an empty island', () => {
      const keeper = createKeeper(0, 0, flat())
      expect(nearestInteractable(keeper, EMPTY_SNAPSHOT, profile, now)).toBeNull()
    })

    it('picks the nearest when several are in reach', () => {
      const snapshot = snapshotWith([
        { angle: 0.30, due: now + 10 * MS_PER_DAY },
        { angle: 0.34, due: now + 10 * MS_PER_DAY },
      ])
      const far = plantPosition(snapshot, profile, 0, now)
      const near = plantPosition(snapshot, profile, 1, now)

      // Stand right on top of the second one.
      const keeper = createKeeper(near.x, near.z, flat())
      const found = nearestInteractable(keeper, snapshot, profile, now)

      expect(found).not.toBeNull()
      expect(found!.pageId).toBe('page-1')
      expect(found!.distance).toBeLessThan(Math.hypot(far.x - near.x, far.z - near.z))
    })

    it('has a reach you can walk into, not a pixel-hunt', () => {
      expect(REACH).toBeGreaterThan(KEEPER.radius * 2)
    })

    it('ignores anything out of reach', () => {
      const snapshot = snapshotWith([{ angle: 0, due: now + 10 * MS_PER_DAY }])
      const keeper = createKeeper(5000, 5000, flat())
      expect(nearestInteractable(keeper, snapshot, profile, now)).toBeNull()
    })

    it('reports a plant in the shallows as beachcombable', () => {
      const snapshot = snapshotWith([{ angle: 0.3, due: now - 3 * MS_PER_DAY }])
      const at = plantPosition(snapshot, profile, 0, now)
      const keeper = createKeeper(at.x, at.z, flat())
      const found = nearestInteractable(keeper, snapshot, profile, now)
      expect(found?.beachcombable).toBe(true)
      expect(actionFor(found, null)).toBe('pick-up')
    })
  })

  function snapshotWith(plants: Array<{ angle: number; due: number }>): IslandSnapshot {
    const count = plants.length
    return {
      ...EMPTY_SNAPSHOT,
      count,
      paths: [],
      angle: Float32Array.from(plants.map((p) => p.angle)),
      due: Float32Array.from(plants.map((p) => p.due)),
      jitter: new Float32Array(count).fill(0.5),
      species: new Uint8Array(count),
      stage: new Uint8Array(count).fill(STAGE.seed),
      scale: new Float32Array(count).fill(1),
      regionIndex: new Uint8Array(count),
      entityId: Uint32Array.from(plants.map((_, i) => i + 1)),
      ids: plants.map((_, i) => `page-${i}`),
      revision: 1,
    }
  }

  function reachable(over: Partial<Parameters<typeof actionFor>[0] & object>) {
    return {
      index: 0, pageId: 'p', distance: 1, beachcombable: false, finished: false,
      x: 0, y: 0, z: 0, ...over,
    } as NonNullable<Parameters<typeof actionFor>[0]>
  }
})

// --- helpers ---------------------------------------------------------------

function groundOf(t: ReturnType<typeof terrace>, x: number, z: number): number {
  const half = t.worldSize / 2
  const gx = Math.floor(((x + half) / t.worldSize) * t.size)
  const gz = Math.floor(((z + half) / t.worldSize) * t.size)
  if (gx < 0 || gz < 0 || gx >= t.size || gz >= t.size) return WATER_LEVEL - 4
  const i = gz * t.size + gx
  if (!t.land[i]) return WATER_LEVEL - 4
  return (t.bands[i] / (t.bandCount - 1)) * t.peakHeight
}

function landAt(t: ReturnType<typeof terrace>, x: number, z: number): boolean {
  const half = t.worldSize / 2
  const gx = Math.floor(((x + half) / t.worldSize) * t.size)
  const gz = Math.floor(((z + half) / t.worldSize) * t.size)
  if (gx < 0 || gz < 0 || gx >= t.size || gz >= t.size) return false
  return Boolean(t.land[gz * t.size + gx])
}
