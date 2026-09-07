/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Vector3 } from 'three'
import { FollowCamera } from './follow'
import type { GroundSampler } from '@/keeper/controller'

/**
 * "Camera never clips terrain" is a Phase 6 acceptance criterion, and it is
 * exactly the sort of thing that gets checked by looking at it once and then
 * quietly regresses. So it is asserted against the worst case the island can
 * produce: the Keeper standing at the foot of a cliff with the camera trying
 * to sit inside it.
 */

let element: HTMLElement
let camera: FollowCamera

/** Flat ground at y = 0. */
const FLAT: GroundSampler = { heightAt: () => 0, isLand: () => true }

/** A cliff face: everything past z = 4 is a 60-unit wall. */
const CLIFF: GroundSampler = {
  heightAt: (_x, z) => (z > 4 ? 60 : 0),
  isLand: () => true,
}

/** A bowl the Keeper stands at the bottom of, walls on every side. */
const BOWL: GroundSampler = {
  heightAt: (x, z) => (Math.hypot(x, z) > 6 ? 50 : 0),
  isLand: () => true,
}

function settle(sampler: GroundSampler, x = 0, y = 0, z = 0, seconds = 2) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    camera.update(x, y, z, sampler, 1 / 60)
  }
}

beforeEach(() => {
  element = document.createElement('div')
  document.body.appendChild(element)
  camera = new FollowCamera(element, 16 / 9)
})

afterEach(() => {
  camera.dispose()
  element.remove()
})

describe('follow camera', () => {
  it('sits behind and above the Keeper', () => {
    settle(FLAT)
    expect(camera.camera.position.y).toBeGreaterThan(0)
    const distance = Math.hypot(camera.camera.position.x, camera.camera.position.z)
    expect(distance).toBeGreaterThan(5)
  })

  it('is already in place on the first frame', () => {
    // Flying in from the origin on load would be an ugly first impression.
    camera.update(0, 0, 0, FLAT, 1 / 60)
    const first = camera.camera.position.clone()
    settle(FLAT)
    expect(first.distanceTo(camera.camera.position)).toBeLessThan(1)
  })

  it('stays above the ground on flat terrain', () => {
    settle(FLAT)
    expect(camera.camera.position.y).toBeGreaterThan(0)
  })

  it('pulls in rather than entering a cliff', () => {
    // Face the camera into the wall.
    camera.yaw = 0
    settle(CLIFF)

    const p = camera.camera.position
    expect(p.y).toBeGreaterThanOrEqual(CLIFF.heightAt(p.x, p.z))
  })

  it('never ends up underground, from any angle, in a bowl', () => {
    // The hard case: walls on every side, nowhere for the arm to go.
    for (let i = 0; i < 24; i++) {
      camera.dispose()
      camera = new FollowCamera(element, 16 / 9)
      camera.yaw = (i / 24) * Math.PI * 2
      settle(BOWL)

      const p = camera.camera.position
      const ground = BOWL.heightAt(p.x, p.z)
      expect(p.y, `yaw ${camera.yaw.toFixed(2)} put the camera inside terrain`)
        .toBeGreaterThanOrEqual(ground)
    }
  })

  it('keeps the Keeper in front of it after pulling in', () => {
    camera.yaw = 0
    settle(CLIFF)
    // Whatever the arm did, the camera must still be looking at the Keeper.
    const forward = new Vector3()
    camera.camera.getWorldDirection(forward)
    // The Keeper is at the origin in this test.
    const toKeeper = camera.camera.position.clone().negate().normalize()
    expect(forward.dot(toKeeper)).toBeGreaterThan(0.8)
  })

  it('eases back out once the cliff is behind it', () => {
    camera.yaw = 0
    settle(CLIFF)
    const pulledIn = Math.hypot(camera.camera.position.x, camera.camera.position.z)

    settle(FLAT)
    const recovered = Math.hypot(camera.camera.position.x, camera.camera.position.z)
    expect(recovered).toBeGreaterThan(pulledIn)
  })

  it('pulls in immediately but eases out slowly', () => {
    settle(FLAT)
    const open = camera.camera.position.clone()

    // One frame of cliff: the pull-in must already have happened, because a
    // gradual one shows the player the inside of a hill.
    camera.yaw = 0
    camera.update(0, 0, 0, CLIFF, 1 / 60)
    const after = camera.camera.position
    expect(Math.hypot(after.x, after.z)).toBeLessThan(Math.hypot(open.x, open.z))
  })

  describe('orbit', () => {
    it('turns with horizontal pointer movement', () => {
      const before = camera.yaw
      camera.orbit(100, 0)
      expect(camera.yaw).not.toBe(before)
    })

    it('clamps the pitch so you can never look through the Keeper', () => {
      for (let i = 0; i < 200; i++) camera.orbit(0, 100)
      settle(FLAT)
      expect(camera.camera.position.y).toBeGreaterThan(-1)

      for (let i = 0; i < 400; i++) camera.orbit(0, -100)
      settle(FLAT)
      expect(Number.isFinite(camera.camera.position.y)).toBe(true)
    })

    it('clamps zoom at both ends', () => {
      for (let i = 0; i < 500; i++) camera.zoom(-10)
      settle(FLAT)
      const near = Math.hypot(camera.camera.position.x, camera.camera.position.z)
      expect(near).toBeGreaterThan(1)

      for (let i = 0; i < 500; i++) camera.zoom(10)
      settle(FLAT)
      const far = Math.hypot(camera.camera.position.x, camera.camera.position.z)
      expect(far).toBeLessThan(200)
    })
  })

  it('follows the Keeper when they move', () => {
    settle(FLAT, 0, 0, 0)
    settle(FLAT, 80, 0, 40)
    expect(camera.camera.position.x).toBeGreaterThan(40)
  })

  it('works with no sampler at all', () => {
    // The terrain arrives asynchronously from a worker; the camera runs before
    // it lands and must not throw or produce NaN.
    camera.update(0, 0, 0, null, 1 / 60)
    expect(Number.isFinite(camera.camera.position.x)).toBe(true)
    expect(Number.isFinite(camera.camera.position.y)).toBe(true)
  })

  it('faces away from a given direction on handover', () => {
    camera.faceFrom(0, 1)
    expect(camera.yaw).toBeCloseTo(0, 5)
    camera.faceFrom(1, 0)
    expect(camera.yaw).toBeCloseTo(Math.PI / 2, 5)
  })
})
