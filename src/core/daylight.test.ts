import { describe, it, expect } from 'vitest'
import { daylightAtHour, daylightAt, greetingFor, toHex } from './daylight'

describe('daylight', () => {
  it('accepts any hour and wraps out-of-range values', () => {
    for (const h of [-6, 0, 5.5, 13, 23.99, 24, 30]) {
      const s = daylightAtHour(h)
      expect(s.hour).toBeGreaterThanOrEqual(0)
      expect(s.hour).toBeLessThan(24)
      expect(Number.isFinite(s.sunIntensity)).toBe(true)
    }
  })

  it('has no seam at midnight', () => {
    // The keyframe list wraps, and getting the wrap wrong produces a visible
    // colour pop at 00:00 that is easy to ship and hard to notice in daylight.
    const before = daylightAtHour(23.99)
    const after = daylightAtHour(0.01)
    expect(Math.abs(before.skyTop.r - after.skyTop.r)).toBeLessThan(0.04)
    expect(Math.abs(before.skyTop.g - after.skyTop.g)).toBeLessThan(0.04)
    expect(Math.abs(before.skyTop.b - after.skyTop.b)).toBeLessThan(0.04)
    expect(Math.abs(before.sunIntensity - after.sunIntensity)).toBeLessThan(0.08)
  })

  it('is continuous across every keyframe boundary', () => {
    let previous = daylightAtHour(0)
    for (let h = 0.05; h < 24; h += 0.05) {
      const current = daylightAtHour(h)
      expect(Math.abs(current.sunIntensity - previous.sunIntensity)).toBeLessThan(0.12)
      previous = current
    }
  })

  it('is brightest in the middle of the day and dimmest at night', () => {
    expect(daylightAtHour(13).sunIntensity).toBeGreaterThan(daylightAtHour(6.5).sunIntensity)
    expect(daylightAtHour(13).sunIntensity).toBeGreaterThan(daylightAtHour(2).sunIntensity)
    expect(daylightAtHour(2).sunIntensity).toBeLessThan(0.6)
  })

  it('never lets the sun graze the horizon or sit straight overhead', () => {
    // Both extremes ruin terraced terrain: a grazing sun drops every plateau
    // into its neighbour's shadow, and an overhead sun removes all the risers'
    // shading at once. The arc is clamped, so this is an invariant, not luck.
    //
    // The bounds are on the *normalised* direction, which runs higher than the
    // clamped elevation itself - at midday the horizontal components shrink to
    // nothing, so normalising pushes y up. What matters is that it never
    // reaches 1 (straight down) and never approaches 0 (raking along the sea).
    let minY = Infinity
    let maxY = -Infinity
    for (let h = 0; h < 24; h += 0.05) {
      const { sunDirection: d } = daylightAtHour(h)
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 5)
      minY = Math.min(minY, d.y)
      maxY = Math.max(maxY, d.y)
    }
    expect(minY).toBeGreaterThan(0.2)
    expect(maxY).toBeLessThan(0.9)
  })

  it('sweeps the sun from one side to the other across the day', () => {
    expect(daylightAtHour(6).sunDirection.x).toBeGreaterThan(0)
    expect(daylightAtHour(19).sunDirection.x).toBeLessThan(0)
  })

  it('keeps daylight in [0,1]', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const d = daylightAtHour(h).daylight
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(1)
    }
  })

  it('names every phase it can produce', () => {
    for (let h = 0; h < 24; h += 0.25) {
      const g = greetingFor(daylightAtHour(h).phase)
      expect(typeof g).toBe('string')
      expect(g.length).toBeGreaterThan(0)
    }
  })

  it('reads the real clock by default', () => {
    const fixed = new Date()
    fixed.setHours(14, 30, 0, 0)
    expect(daylightAt(fixed).hour).toBeCloseTo(14.5, 3)
  })

  it('emits hex the DOM half can use directly', () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(toHex({ r: 1, g: 1, b: 1 })).toBe('#ffffff')
    // Out-of-gamut values are clamped rather than producing a broken string.
    expect(toHex({ r: 2, g: -1, b: 0.5 })).toMatch(/^#[0-9a-f]{6}$/)
  })
})
