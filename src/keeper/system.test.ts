import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KeeperSystem } from './system'
import { plantPosition } from './interaction'
import { KEEPER } from './controller'
import { SIT_AFTER_SECONDS } from './animation'
import { buildRadialProfile } from '@/render/terrain/profile'
import { terrace, type TerracedField } from '@/render/terrain/terrace'
import { generateBaseHeightfield, downsample, normalise, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { terrainSeed } from '@/core/hash'
import { TERRAIN } from '@/core/config'
import { EMPTY_SNAPSHOT, MS_PER_DAY, STAGE, type IslandSnapshot } from '@/island/derive'

/**
 * The Phase 6 acceptance criteria, as tests:
 *
 *   "Tend a plant to complete its task."
 *   "Carry an overdue plant from the shallows uphill and watch the due date
 *    update."
 *
 * Both are checked here end to end - reach, prompt, action, intent - because
 * they are the two interactions that make the island an input surface rather
 * than a picture of one.
 */

const NOW = Date.UTC(2026, 2, 1, 12)
const STILL = { strafe: 0, forward: 0, cameraYaw: 0, run: false, jump: false }

let field: TerracedField
let profile: ReturnType<typeof buildRadialProfile>

function buildIsland(): TerracedField {
  const seed = terrainSeed('first-isle')
  const raw = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(raw, 72)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
  return terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
}

function snapshotOf(plants: Array<{ angle: number; due: number; stage?: number }>): IslandSnapshot {
  const count = plants.length
  return {
    ...EMPTY_SNAPSHOT,
    count,
    paths: [],
    angle: Float32Array.from(plants.map((p) => p.angle)),
    due: Float32Array.from(plants.map((p) => p.due)),
    jitter: new Float32Array(count).fill(0.5),
    species: new Uint8Array(count),
    stage: Uint8Array.from(plants.map((p) => p.stage ?? STAGE.seed)),
    scale: new Float32Array(count).fill(1),
    regionIndex: new Uint8Array(count),
    entityId: Uint32Array.from(plants.map((_, i) => i + 1)),
    ids: plants.map((_, i) => `page-${i}`),
    revision: 1,
  }
}

/** Put the Keeper exactly where a plant is, so it is certainly in reach. */
function standAt(system: KeeperSystem, snapshot: IslandSnapshot, index: number) {
  const at = plantPosition(snapshot, profile, index, NOW)
  system.state.x = at.x
  system.state.z = at.z
  system.fixedUpdate(STILL, 1 / 60)
}

function makeSystem(): KeeperSystem {
  const system = new KeeperSystem()
  system.now = () => NOW
  system.setField(field)
  system.setProfile(profile)
  return system
}

beforeEach(() => {
  if (!field) {
    field = buildIsland()
    profile = buildRadialProfile(field)
  }
})

describe('KeeperSystem', () => {
  it('stands on land as soon as it is given an island', () => {
    const system = makeSystem()
    expect(system.sampled).not.toBeNull()
    expect(system.sampled!.isLand(system.state.x, system.state.z)).toBe(true)
    expect(system.state.grounded).toBe(true)
  })

  it('does nothing at all before the terrain arrives', () => {
    // Terrain comes from a worker; frames run before it lands.
    const system = new KeeperSystem()
    expect(() => system.fixedUpdate(STILL, 1 / 60)).not.toThrow()
    expect(system.state.x).toBe(0)
  })

  it('re-foots the Keeper when the island is regenerated under them', () => {
    const system = makeSystem()
    // Strand them out at sea, then hand over a fresh island.
    system.state.x = 900
    system.state.z = 900
    system.setField(field)
    expect(system.sampled!.isLand(system.state.x, system.state.z)).toBe(true)
  })

  describe('tending a plant completes its task', () => {
    it('offers the prompt when a plant is in reach', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW + 20 * MS_PER_DAY }])
      system.titleFor = () => 'Two Sum'
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)

      expect(system.status.action).toBe('tend')
      expect(system.status.prompt).toContain('Two Sum')
    })

    it('fires the tend intent, once, after the animation', () => {
      const system = makeSystem()
      const onTend = vi.fn()
      system.onTend = onTend
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW + 20 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)

      system.interact()
      // The action has weight: nothing has happened yet.
      expect(onTend).not.toHaveBeenCalled()

      for (let i = 0; i < 120; i++) system.fixedUpdate(STILL, 1 / 60)
      expect(onTend).toHaveBeenCalledTimes(1)
      expect(onTend).toHaveBeenCalledWith('page-0')

      // And it does not fire again on later frames.
      for (let i = 0; i < 120; i++) system.fixedUpdate(STILL, 1 / 60)
      expect(onTend).toHaveBeenCalledTimes(1)
    })

    it('holds the Keeper still mid-tend', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW + 20 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      system.interact()

      const before = { x: system.state.x, z: system.state.z }
      // Player mashes forward during the tend.
      for (let i = 0; i < 30; i++) {
        system.fixedUpdate({ ...STILL, forward: 1, run: true }, 1 / 60)
      }
      expect(system.state.x).toBeCloseTo(before.x, 3)
      expect(system.state.z).toBeCloseTo(before.z, 3)
      expect(system.animation.current).toBe('tend')
    })

    it('offers nothing on a plant that is already a lantern', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([
        { angle: 0.4, due: NOW + 20 * MS_PER_DAY, stage: STAGE.lantern },
      ])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      expect(system.status.action).toBe('none')
      expect(system.status.prompt).toBe('')
    })

    it('offers nothing when nothing is nearby', () => {
      const system = makeSystem()
      system.setSnapshot(snapshotOf([{ angle: 2.5, due: NOW + 20 * MS_PER_DAY }]))
      system.state.x = 0
      system.state.z = 0
      system.fixedUpdate(STILL, 1 / 60)
      expect(system.status.action).toBe('none')
    })
  })

  describe('carrying an overdue plant uphill reschedules it', () => {
    it('lifts an overdue plant out of the shallows', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW - 5 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)

      expect(system.status.action).toBe('pick-up')
      system.interact()
      expect(system.isCarrying).toBe(true)
      expect(system.status.carrying).toBe('page-0')
      // Carrying changes the whole silhouette, so it outranks gait.
      system.fixedUpdate(STILL, 1 / 60)
      expect(system.animation.current).toBe('carry')
    })

    it('offers only put-down while carrying, whatever else is in reach', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([
        { angle: 0.4, due: NOW - 5 * MS_PER_DAY },
        { angle: 0.41, due: NOW + 20 * MS_PER_DAY },
      ])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      system.interact()
      system.fixedUpdate(STILL, 1 / 60)
      expect(system.status.action).toBe('put-down')
    })

    it('sets a later due date the higher up it is put down', () => {
      const shore = rescheduleAt(0.95)
      const midway = rescheduleAt(0.55)
      const inland = rescheduleAt(0.2)

      expect(midway).toBeGreaterThan(shore)
      expect(inland).toBeGreaterThan(midway)
    })

    it('never sets a date that is already overdue', () => {
      // Rescuing a plant and having it be late again where you set it down
      // would be a small cruelty.
      for (const fraction of [0.99, 0.9, 0.7, 0.5, 0.3, 0.1]) {
        expect(rescheduleAt(fraction)).toBeGreaterThan(NOW)
      }
    })

    it('stops carrying once it is set down', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW - 5 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      system.interact()
      expect(system.isCarrying).toBe(true)

      system.interact()
      expect(system.isCarrying).toBe(false)
      expect(system.status.carrying).toBeNull()
    })

    it('drops a plant that was deleted from the workspace while in hand', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW - 5 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      system.interact()
      expect(system.isCarrying).toBe(true)

      // The page is deleted in the DOM interface; the next derive omits it.
      system.setSnapshot(snapshotOf([]))
      expect(system.isCarrying).toBe(false)
    })

    /** Carry a plant to a fraction of the way out from the centre, drop it. */
    function rescheduleAt(radiusFraction: number): number {
      const system = makeSystem()
      const onReschedule = vi.fn()
      system.onReschedule = onReschedule
      const snapshot = snapshotOf([{ angle: 0, due: NOW - 5 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      system.interact()

      const radius = profile.maxRadius[0] * radiusFraction
      system.state.x = radius
      system.state.z = 0
      system.fixedUpdate(STILL, 1 / 60)
      system.interact()

      expect(onReschedule).toHaveBeenCalledTimes(1)
      return onReschedule.mock.calls[0][1] as number
    }
  })

  describe('the prompt', () => {
    it('is announced only when it changes', () => {
      const system = makeSystem()
      const onPromptChange = vi.fn()
      system.onPromptChange = onPromptChange
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW + 20 * MS_PER_DAY }])
      system.setSnapshot(snapshot)

      standAt(system, snapshot, 0)
      const afterArriving = onPromptChange.mock.calls.length
      expect(afterArriving).toBeGreaterThan(0)

      // Standing still in reach must not re-announce every frame.
      for (let i = 0; i < 60; i++) system.fixedUpdate(STILL, 1 / 60)
      expect(onPromptChange).toHaveBeenCalledTimes(afterArriving)
    })

    it('clears when the Keeper walks away', () => {
      const system = makeSystem()
      const snapshot = snapshotOf([{ angle: 0.4, due: NOW + 20 * MS_PER_DAY }])
      system.setSnapshot(snapshot)
      standAt(system, snapshot, 0)
      expect(system.status.prompt).not.toBe('')

      system.state.x += 200
      system.fixedUpdate(STILL, 1 / 60)
      expect(system.status.prompt).toBe('')
      expect(system.status.action).toBe('none')
    })
  })

  describe('resting', () => {
    it('sits down after standing still long enough', () => {
      const system = makeSystem()
      const steps = Math.ceil((SIT_AFTER_SECONDS + 1) * 60)
      for (let i = 0; i < steps; i++) system.fixedUpdate(STILL, 1 / 60)
      expect(system.animation.current).toBe('sit')
    })

    it('gets up again as soon as the player moves', () => {
      const system = makeSystem()
      const steps = Math.ceil((SIT_AFTER_SECONDS + 1) * 60)
      for (let i = 0; i < steps; i++) system.fixedUpdate(STILL, 1 / 60)
      expect(system.animation.current).toBe('sit')

      for (let i = 0; i < 30; i++) {
        system.fixedUpdate({ ...STILL, forward: 1 }, 1 / 60)
      }
      expect(system.animation.current).toBe('walk')
    })
  })

  it('exposes a finite pose every frame', () => {
    const system = makeSystem()
    for (let i = 0; i < 200; i++) {
      system.fixedUpdate({ ...STILL, forward: 1, run: i % 2 === 0 }, 1 / 60)
      for (const value of Object.values(system.pose)) {
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('keeps the Keeper on the island over a long walk', () => {
    const system = makeSystem()
    for (let i = 0; i < 1800; i++) {
      const yaw = Math.sin(i / 200) * Math.PI
      system.fixedUpdate({ ...STILL, forward: 1, cameraYaw: yaw, run: true }, 1 / 60)
    }
    expect(Number.isFinite(system.state.x)).toBe(true)
    expect(system.state.y).toBeGreaterThan(-KEEPER.wadeDepth - 1)
    expect(system.state.y).toBeLessThan(TERRAIN.peakHeight + 2)
  })
})
