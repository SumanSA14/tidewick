import { describe, it, expect } from 'vitest'
import { KEEPER } from './controller'
import { terrace, type TerracedField } from '@/render/terrain/terrace'
import { generateBaseHeightfield, downsample, normalise, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { terrainSeed } from '@/core/hash'
import { TERRAIN } from '@/core/config'

/**
 * Is the island connected?
 *
 * Phase 6 asks that the Keeper can "walk the full island without getting
 * stuck". Walking test rays in straight lines cannot answer that: a ray that
 * stops at a cliff is the controller working correctly, and a ray that travels
 * far may just be sliding along a wall it never climbs. Either way a real
 * player steers, and a straight line does not.
 *
 * So the question is asked of the terrain instead: flood fill from the
 * shoreline using the Keeper's own step rule, and check every land cell is
 * reachable. This is a stronger gate than any walk, and it doubles as a
 * regression guard on a config relationship that is easy to break silently -
 * the terrace riser must stay under `stepOffset`, or the isle quietly becomes
 * unclimbable and no amount of controller tuning will fix it.
 */

function buildIsland(name: string): TerracedField {
  const seed = terrainSeed(name)
  const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(field, 72)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
  return terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

interface Reach {
  land: number
  reached: number
  peakBand: number
  peakReached: boolean
}

/** Flood fill from the shore, climbing only risers within the step offset. */
function floodFromShore(t: TerracedField, stepOffset: number = KEEPER.stepOffset): Reach {
  const n = t.size
  const at = (gx: number, gz: number) => gz * n + gx
  const heightOf = (gx: number, gz: number) =>
    (t.bands[at(gx, gz)] / (t.bandCount - 1)) * t.peakHeight

  const seen = new Uint8Array(n * n)
  const queue: number[] = []

  // Seed: every land cell touching water. The Keeper arrives by wading, so
  // the whole coast is a valid starting point.
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      if (!t.land[at(gx, gz)]) continue
      const coastal = NEIGHBOURS.some(([ox, oz]) => {
        const nx = gx + ox
        const nz = gz + oz
        return nx < 0 || nz < 0 || nx >= n || nz >= n || !t.land[at(nx, nz)]
      })
      if (coastal) {
        seen[at(gx, gz)] = 1
        queue.push(at(gx, gz))
      }
    }
  }

  for (let q = 0; q < queue.length; q++) {
    const gx = queue[q] % n
    const gz = (queue[q] / n) | 0
    const here = heightOf(gx, gz)
    for (const [ox, oz] of NEIGHBOURS) {
      const nx = gx + ox
      const nz = gz + oz
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue
      const ni = at(nx, nz)
      if (seen[ni] || !t.land[ni]) continue
      // Climbing is limited; falling never is.
      if (heightOf(nx, nz) - here > stepOffset) continue
      seen[ni] = 1
      queue.push(ni)
    }
  }

  let land = 0
  let reached = 0
  let peakBand = 0
  for (let i = 0; i < n * n; i++) {
    if (!t.land[i]) continue
    land++
    if (seen[i]) reached++
    if (t.bands[i] > peakBand) peakBand = t.bands[i]
  }

  let peakReached = false
  for (let i = 0; i < n * n; i++) {
    if (t.land[i] && t.bands[i] === peakBand && seen[i]) { peakReached = true; break }
  }

  return { land, reached, peakBand, peakReached }
}

describe('island reachability', () => {
  it('keeps the terrace riser inside the Keeper step offset', () => {
    // The whole gate rests on this one relationship. If a future change to
    // peakHeight or terraceBands pushes the riser above the step offset, every
    // terrace becomes a wall - so it is asserted directly rather than left to
    // be discovered by walking into it.
    const riser = TERRAIN.peakHeight / (TERRAIN.terraceBands - 1)
    expect(riser).toBeLessThan(KEEPER.stepOffset)
  })

  it('can reach every part of the island from the shore', () => {
    const reach = floodFromShore(buildIsland('first-isle'))
    expect(reach.land).toBeGreaterThan(1000)
    expect(reach.reached).toBe(reach.land)
  })

  it('can reach the summit', () => {
    const reach = floodFromShore(buildIsland('first-isle'))
    expect(reach.peakBand).toBeGreaterThan(0)
    expect(reach.peakReached).toBe(true)
  })

  it('stays connected across different workspaces', () => {
    // Terrain is seeded per workspace, so "it works on mine" is not an answer.
    for (const name of ['tidewick', 'second-isle', 'a', 'workspace-42']) {
      const reach = floodFromShore(buildIsland(name))
      expect(reach.land).toBeGreaterThan(200)
      expect(reach.reached, `${name} has unreachable ground`).toBe(reach.land)
      expect(reach.peakReached, `${name} has an unreachable summit`).toBe(true)
    }
  })

  it('would strand the Keeper if the step offset were realistic', () => {
    // Guards the reasoning behind the generous step offset, which otherwise
    // reads like a value someone picked to make a test pass. A human step
    // height cannot clear a terrace, and the isle falls apart.
    const reach = floodFromShore(buildIsland('first-isle'), 0.6)
    expect(reach.reached).toBeLessThan(reach.land)
    expect(reach.peakReached).toBe(false)
  })
})
