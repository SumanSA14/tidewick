import { describe, it, expect } from 'vitest'
import { terrace, DESATURATION_START, type TerracedField } from './terrace'
import { generateBaseHeightfield, downsample, normalise, smoothField } from './heightfield'
import { erodeCPU } from './erosionCPU'
import { terrainSeed } from '@/core/hash'
import { TERRAIN } from '@/core/config'

/**
 * How much of the island is green?
 *
 * Art direction is usually defended by looking at it once, which is how the
 * band palette came to paint 42.7% of the isle as washed-out upland scrub while
 * its comment claimed the stops followed the measured histogram. They did not:
 * the height remap puts the mode of the distribution high, so the desaturation
 * ramp captured the island's single largest cluster of land.
 *
 * The fix is a number rather than an opinion. Terrain is seeded per workspace,
 * so this is checked across several seeds - "it looks right on mine" is exactly
 * the reasoning that produced the bug.
 */

function buildIsland(name: string): TerracedField {
  const seed = terrainSeed(name)
  const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(field, TERRAIN.terraceGrid)
  const smoothed = smoothField(
    { data: coarse.data.slice(), size: coarse.size },
    TERRAIN.terraceSmoothing, 1,
  )
  return terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
}

/** Fraction of land cells the palette paints as stone rather than green. */
function desaturatedFraction(t: TerracedField): number {
  let land = 0
  let high = 0
  for (let i = 0; i < t.bands.length; i++) {
    if (!t.land[i]) continue
    land++
    if (t.bands[i] / (t.bandCount - 1) >= DESATURATION_START) high++
  }
  return land === 0 ? 0 : high / land
}

const SEEDS = ['first-isle', 'tidewick', 'second-isle', 'a', 'workspace-42', 'thornwick']

describe('band palette', () => {
  it('leaves most of every island green', () => {
    for (const name of SEEDS) {
      const fraction = desaturatedFraction(buildIsland(name))
      // A highland cap is wanted; a grey island is not. The regression this
      // guards sat at 0.427.
      expect(fraction, `${name} is ${(fraction * 100).toFixed(1)}% stone`)
        .toBeLessThan(0.30)
    }
  })

  it('still gives every island some high ground', () => {
    // The opposite failure: pushing the threshold so high that the palette
    // never reaches stone, and the peak looks like the shore.
    let withHighland = 0
    for (const name of SEEDS) {
      if (desaturatedFraction(buildIsland(name)) > 0.005) withHighland++
    }
    expect(withHighland).toBeGreaterThanOrEqual(SEEDS.length - 1)
  })

  it('keeps the beach for the waterline only', () => {
    // Band 0 is painted sand. If it swallowed a large share of the island the
    // isle would read as a sandbar.
    for (const name of SEEDS) {
      const t = buildIsland(name)
      let land = 0
      let beach = 0
      for (let i = 0; i < t.bands.length; i++) {
        if (!t.land[i]) continue
        land++
        if (t.bands[i] === 0) beach++
      }
      expect(beach / land, `${name} is ${((beach / land) * 100).toFixed(1)}% sand`)
        .toBeLessThan(0.35)
    }
  })
})
