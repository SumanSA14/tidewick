import { describe, it, expect } from 'vitest'
import { createBirds, BOID } from './birds'
import type { GroundSampler } from '@/keeper/controller'

/**
 * The CPU flock.
 *
 * Three things a flock must do to be worth drawing - stay finite, stay in its
 * speed band, and stay out of the hills - and one thing it must do to be
 * *birds* rather than confetti: gather. The first build at cohesion 0.55 spread
 * 10,000 agents evenly over the sea; the group test below is what "recognisably
 * a flock" means as a number.
 *
 * Timing is a scaling ratio, not a stopwatch - see perf-tests-assert-scaling.
 */

const FLAT: GroundSampler = { heightAt: () => 0, isLand: () => true }

/** A hill in the flight path, tall enough that the ring would clip it. */
const HILL: GroundSampler = {
  heightAt: (x, z) => (Math.hypot(x - BOID.ringRadius, z) < 30 ? 70 : 0),
  isLand: () => true,
}

function positions(birds: ReturnType<typeof createBirds>): Float32Array {
  const attr = birds.mesh.geometry.getAttribute('bPos')
  return attr.array as Float32Array
}

function run(birds: ReturnType<typeof createBirds>, ground: GroundSampler, seconds: number) {
  birds.setLight(1)
  const dt = 1 / 60
  for (let i = 0; i < Math.round(seconds * 60); i++) birds.step(dt, ground)
}

describe('birds', () => {
  it('stays finite over a long flight', () => {
    const birds = createBirds(300, 7)
    run(birds, FLAT, 60)
    const pos = positions(birds)
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i])).toBe(true)
  })

  it('keeps every bird inside the speed band', () => {
    const birds = createBirds(300, 7)
    run(birds, FLAT, 10)
    const dir = birds.mesh.geometry.getAttribute('bDir').array as Float32Array
    for (let i = 0; i < 300; i++) {
      const speed = Math.hypot(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2])
      expect(speed).toBeGreaterThanOrEqual(BOID.minSpeed - 1e-3)
      expect(speed).toBeLessThanOrEqual(BOID.maxSpeed + 1e-3)
    }
  })

  it('never flies through a hill', () => {
    // A 70-unit hill under the ring: every bird that crosses it must rise.
    const birds = createBirds(300, 7)
    run(birds, HILL, 40)
    const pos = positions(birds)
    let violations = 0
    for (let i = 0; i < 300; i++) {
      const floor = HILL.heightAt(pos[i * 3], pos[i * 3 + 2])
      if (pos[i * 3 + 1] < floor) violations++
    }
    expect(violations).toBe(0)
  })

  it('stays near the isle rather than dispersing', () => {
    const birds = createBirds(300, 7)
    run(birds, FLAT, 60)
    const pos = positions(birds)
    let far = 0
    for (let i = 0; i < 300; i++) {
      if (Math.hypot(pos[i * 3], pos[i * 3 + 2]) > BOID.ringRadius * 2.2) far++
    }
    expect(far).toBeLessThan(300 * 0.05)
  })

  it('flies as a few distinct groups', () => {
    /**
     * Birds are recognisable by the group. Two readings after half a minute:
     * each bird stays close to its own flock's centre (compact), and the flock
     * centres stay well apart (distinct). Together that is "a few loose flocks
     * with empty sky between them" as numbers - and neither is satisfied by the
     * uniform ring the first build produced.
     *
     * An earlier version compared neighbour-count variance against a
     * hand-built "uniform" baseline; the baseline turned out not to be uniform
     * and the comparison meant nothing. Centroids are harder to get wrong.
     */
    const count = 260
    const birds = createBirds(count, 7)
    run(birds, FLAT, 30)
    const pos = positions(birds)

    const cx = new Float64Array(BOID.flocks)
    const cy = new Float64Array(BOID.flocks)
    const cz = new Float64Array(BOID.flocks)
    const n = new Int32Array(BOID.flocks)
    for (let i = 0; i < count; i++) {
      const f = i % BOID.flocks
      cx[f] += pos[i * 3]; cy[f] += pos[i * 3 + 1]; cz[f] += pos[i * 3 + 2]; n[f]++
    }
    for (let f = 0; f < BOID.flocks; f++) { cx[f] /= n[f]; cy[f] /= n[f]; cz[f] /= n[f] }

    let spread = 0
    for (let i = 0; i < count; i++) {
      const f = i % BOID.flocks
      spread += Math.hypot(pos[i * 3] - cx[f], pos[i * 3 + 1] - cy[f], pos[i * 3 + 2] - cz[f])
    }
    // Compact: the ring is ~600 units round; a group is tens of units across.
    expect(spread / count).toBeLessThan(BOID.ringWidth)

    // Distinct: centroids far apart relative to the groups' own size.
    let pairs = 0
    let separation = 0
    for (let a = 0; a < BOID.flocks; a++) {
      for (let b = a + 1; b < BOID.flocks; b++) {
        separation += Math.hypot(cx[a] - cx[b], cy[a] - cy[b], cz[a] - cz[b])
        pairs++
      }
    }
    expect(separation / pairs).toBeGreaterThan(BOID.ringWidth * 2)
  })

  it('roosts at night', () => {
    const birds = createBirds(100, 7)
    birds.setLight(0.05)
    birds.step(1 / 60, FLAT)
    expect(birds.mesh.visible).toBe(false)
    birds.setLight(1)
    birds.step(1 / 60, FLAT)
    expect(birds.mesh.visible).toBe(true)
  })

  it('handles an empty flock', () => {
    const birds = createBirds(0, 7)
    expect(() => run(birds, FLAT, 1)).not.toThrow()
    expect(birds.mesh.visible).toBe(false)
  })

  it('scales like a spatial hash, not like all-pairs', () => {
    /**
     * The claim in birds.ts is that 10k agents fit the CPU budget because of
     * the hash. Quadrupling the flock should cost roughly four times, not
     * sixteen; the bound of 8 sits between the two with room for a loaded
     * machine.
     */
    const time = (count: number): number => {
      const birds = createBirds(count, 11)
      birds.setLight(1)
      birds.step(1 / BOID.hz, FLAT) // warm up, and build the hash once
      const samples: number[] = []
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now()
        birds.step(1 / BOID.hz, FLAT)
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return samples[3]
    }
    const small = time(2_500)
    const large = time(10_000)
    if (small > 0.4) expect(large / small).toBeLessThan(8)
    // The absolute figure that matters for the frame budget: one 10k step at
    // 30 Hz, generous enough for a busy machine.
    expect(large).toBeLessThan(60)
  })
})
