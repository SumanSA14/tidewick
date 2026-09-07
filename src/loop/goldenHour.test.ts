import { describe, it, expect } from 'vitest'
import { applyGoldenHour, goldenDepth } from './goldenHour'
import { daylightAt } from '@/core/daylight'
import { WARMTH } from './economy'

/**
 * Golden hour.
 *
 * "A 25-minute session produces Sunlight and *visibly* warms the light" is an
 * acceptance criterion, so "visibly" is given a number here rather than being
 * left to whoever looks at it next.
 */

/** Perceived warmth: how far the light leans to red over blue. */
function warmthOf(rgb: { r: number; g: number; b: number }): number {
  return rgb.r - rgb.b
}

const NOON = daylightAt(new Date(2026, 5, 1, 12))
const MORNING = daylightAt(new Date(2026, 5, 1, 9))

describe('goldenDepth', () => {
  it('is zero before a session starts', () => {
    expect(goldenDepth(0, WARMTH.base)).toBe(0)
  })

  it('ramps in rather than snapping on', () => {
    // Starting a timer must not visibly change the screen; by the time you
    // notice, it should already have happened.
    const first = goldenDepth(0.02, WARMTH.base)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(0.05)
  })

  it('is fully in by a third of the way through', () => {
    expect(goldenDepth(0.34, WARMTH.base)).toBeCloseTo(1, 1)
  })

  it('warms a distracted session far less', () => {
    const focused = goldenDepth(0.5, WARMTH.max)
    const distracted = goldenDepth(0.5, WARMTH.min)
    expect(distracted).toBeLessThan(focused)
    // The light is a record of attention, not of elapsed time.
    expect(distracted).toBeLessThan(0.5)
  })

  it('never exceeds one', () => {
    expect(goldenDepth(1, WARMTH.max * 4)).toBe(1)
    expect(goldenDepth(10, WARMTH.max)).toBe(1)
  })

  it('never goes negative', () => {
    expect(goldenDepth(-1, WARMTH.base)).toBe(0)
    expect(goldenDepth(0.5, 0)).toBeGreaterThanOrEqual(0)
  })
})

describe('applyGoldenHour', () => {
  it('changes nothing at zero depth', () => {
    expect(applyGoldenHour(NOON, 0)).toBe(NOON)
  })

  it('visibly warms the sun', () => {
    const gold = applyGoldenHour(NOON, 1)
    const before = warmthOf(NOON.sun)
    const after = warmthOf(gold.sun)
    expect(after).toBeGreaterThan(before)
    // "Visibly" given a number: a shift too small to see would not satisfy
    // the acceptance criterion.
    expect(after - before).toBeGreaterThan(0.08)
  })

  it('warms progressively with depth', () => {
    const quarter = warmthOf(applyGoldenHour(NOON, 0.25).sun)
    const half = warmthOf(applyGoldenHour(NOON, 0.5).sun)
    const full = warmthOf(applyGoldenHour(NOON, 1).sun)
    expect(half).toBeGreaterThan(quarter)
    expect(full).toBeGreaterThan(half)
  })

  it('rakes the sun toward the horizon', () => {
    // A raking light is what makes the terraces read, and it is what golden
    // hour actually means.
    const gold = applyGoldenHour(NOON, 1)
    expect(gold.sunDirection.y).toBeLessThan(NOON.sunDirection.y)
  })

  it('keeps the sun direction normalised', () => {
    for (const depth of [0.2, 0.5, 0.8, 1]) {
      const d = applyGoldenHour(MORNING, depth).sunDirection
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6)
    }
  })

  it('never puts the sun below the horizon', () => {
    // The solar arc is already art-directed to a raking range; golden hour
    // must not push it under the island and light everything from beneath.
    for (const hour of [6, 9, 12, 15, 18, 19]) {
      const state = daylightAt(new Date(2026, 5, 1, hour))
      expect(applyGoldenHour(state, 1).sunDirection.y).toBeGreaterThan(0)
    }
  })

  it('warms the key light more than the bounce', () => {
    // Warming both equally washes the scene flat; the contrast between them
    // is the effect.
    const gold = applyGoldenHour(NOON, 1)
    const sunShift = warmthOf(gold.sun) - warmthOf(NOON.sun)
    const ambientShift = warmthOf(gold.ambient) - warmthOf(NOON.ambient)
    expect(sunShift).toBeGreaterThan(ambientShift)
  })

  it('lifts the sun intensity without blowing it out', () => {
    const gold = applyGoldenHour(NOON, 1)
    expect(gold.sunIntensity).toBeGreaterThan(NOON.sunIntensity)
    expect(gold.sunIntensity).toBeLessThan(NOON.sunIntensity * 1.5)
  })

  it('leaves the hour and phase alone', () => {
    // It is still whatever time it actually is - lit as though the sun had
    // dropped, not moved to a different hour.
    const gold = applyGoldenHour(MORNING, 1)
    expect(gold.hour).toBe(MORNING.hour)
    expect(gold.phase).toBe(MORNING.phase)
  })

  it('produces finite colours at every hour and depth', () => {
    for (let hour = 0; hour < 24; hour += 2) {
      const state = daylightAt(new Date(2026, 5, 1, hour))
      for (const depth of [0.1, 0.5, 1]) {
        const gold = applyGoldenHour(state, depth)
        for (const channel of [gold.sun, gold.ambient, gold.glow, gold.skyHorizon]) {
          expect(Number.isFinite(channel.r)).toBe(true)
          expect(Number.isFinite(channel.g)).toBe(true)
          expect(Number.isFinite(channel.b)).toBe(true)
        }
      }
    }
  })

  it('clamps a depth outside the range', () => {
    expect(applyGoldenHour(NOON, -1)).toBe(NOON)
    const over = applyGoldenHour(NOON, 5)
    const full = applyGoldenHour(NOON, 1)
    expect(over.sun.r).toBeCloseTo(full.sun.r, 6)
  })
})
