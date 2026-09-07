import { describe, it, expect } from 'vitest'
import { generateBaseHeightfield, downsample, normalise, smoothField } from './heightfield'
import { erodeCPU } from './erosionCPU'
import { terrace } from './terrace'
import { buildRadialProfile, sampleProfile, profileToTexture } from './profile'
import { terrainSeed } from '@/core/hash'
import { TERRAIN } from '@/core/config'

/**
 * The radial profile is what turns "how long until this is due" into a place
 * on the island, so an error here does not look like a bug - it looks like the
 * elevation mechanic being wrong.
 */
describe('radial profile', () => {
  const seed = terrainSeed('first-isle')
  const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(field, 72)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
  const terraced = terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
  const profile = buildRadialProfile(terraced, 32, 24)

  it('covers every angle and elevation', () => {
    expect(profile.data.length).toBe(32 * 24 * 2)
    for (const v of profile.data) expect(Number.isFinite(v)).toBe(true)
  })

  it('never places anything beyond the coastline', () => {
    for (let a = 0; a < profile.angles; a++) {
      for (let l = 0; l < profile.levels; l++) {
        const radius = profile.data[(a * profile.levels + l) * 2]
        expect(radius).toBeLessThanOrEqual(profile.maxRadius[a] + 1e-6)
      }
    }
  })

  it('puts the waterline at the coast, not at the centre', () => {
    // Regression. The "nothing on this ray reached that high" fallback used to
    // test `height === 0`, which at the waterline is a *legitimate* result -
    // so every task due today was flung to the middle of the island and buried
    // inside the peak. The island looked empty and the data looked perfect.
    for (let a = 0; a < profile.angles; a++) {
      if (profile.maxRadius[a] <= 0) continue
      const radiusAtWater = profile.data[(a * profile.levels + 0) * 2]
      expect(radiusAtWater).toBeGreaterThan(profile.maxRadius[a] * 0.5)
    }
  })

  it('moves inward as elevation rises', () => {
    // The isle is a mound, so higher ground is nearer the middle. Not strictly
    // monotonic - terraces are flat - but the trend has to hold or the whole
    // "far future sits in the highlands" reading breaks.
    for (let a = 0; a < profile.angles; a++) {
      if (profile.maxRadius[a] <= 0) continue
      const low = profile.data[(a * profile.levels + 1) * 2]
      const high = profile.data[(a * profile.levels + profile.levels - 1) * 2]
      expect(high).toBeLessThanOrEqual(low + 1e-6)
    }
  })

  it('rises as elevation rises', () => {
    for (let a = 0; a < profile.angles; a++) {
      if (profile.maxRadius[a] <= 0) continue
      const low = profile.data[(a * profile.levels + 0) * 2 + 1]
      const high = profile.data[(a * profile.levels + profile.levels - 1) * 2 + 1]
      expect(high).toBeGreaterThanOrEqual(low)
    }
  })

  it('never returns a height above the peak', () => {
    for (let i = 1; i < profile.data.length; i += 2) {
      expect(profile.data[i]).toBeLessThanOrEqual(TERRAIN.peakHeight + 1e-6)
      expect(profile.data[i]).toBeGreaterThanOrEqual(0)
    }
  })

  describe('sampling', () => {
    it('wraps the angle, so the seam behind the isle is not a cliff', () => {
      const before = sampleProfile(profile, Math.PI * 2 - 1e-4, 0.5)
      const after = sampleProfile(profile, 1e-4, 0.5)
      expect(Math.abs(before.radius - after.radius)).toBeLessThan(profile.worldSize * 0.12)
    })

    it('clamps elevation outside [0,1] rather than reading off the end', () => {
      const below = sampleProfile(profile, 1, -3)
      const above = sampleProfile(profile, 1, 9)
      expect(Number.isFinite(below.radius)).toBe(true)
      expect(Number.isFinite(above.radius)).toBe(true)
      expect(below.radius).toBeGreaterThanOrEqual(above.radius)
    })

    it('matches the stored cell at an exact sample point', () => {
      const a = 5
      const l = 7
      const angle = (a / profile.angles) * Math.PI * 2
      const level = l / (profile.levels - 1)
      const sampled = sampleProfile(profile, angle, level)
      expect(sampled.radius).toBeCloseTo(profile.data[(a * profile.levels + l) * 2], 4)
      expect(sampled.height).toBeCloseTo(profile.data[(a * profile.levels + l) * 2 + 1], 4)
    })
  })

  it('packs to a texture the shader can read', () => {
    const packed = profileToTexture(profile)
    // Elevation on x, angle on y - the order the vertex shader samples in.
    expect(packed.width).toBe(profile.levels)
    expect(packed.height).toBe(profile.angles)
    expect(packed.data.length).toBe(profile.angles * profile.levels * 4)
    expect(packed.data[0]).toBe(profile.data[0])
    expect(packed.data[1]).toBe(profile.data[1])
  })
})
