import { describe, it, expect } from 'vitest'
import { generateBaseHeightfield, normalise, downsample, smoothField, sampleBilinear } from './heightfield'
import { erodeCPU } from './erosionCPU'
import { terrace, buildTerrainGeometry, bandHeight, sampleGroundHeight } from './terrace'
import { buildBrushBuffers, generateSpawns } from './erosionGPU'
import { terrainSeed, hashString } from '@/core/hash'
import { TERRAIN } from '@/core/config'

const SMALL = 96

describe('terrain seed', () => {
  it('is stable for the same workspace id', () => {
    expect(terrainSeed('first-isle')).toBe(terrainSeed('first-isle'))
  })

  it('differs between workspaces', () => {
    expect(terrainSeed('first-isle')).not.toBe(terrainSeed('second-isle'))
  })

  it('is a plain unsigned 32-bit integer, so it survives a round trip', () => {
    const seed = terrainSeed('first-isle')
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThan(2 ** 32)
    expect(JSON.parse(JSON.stringify(seed))).toBe(seed)
  })

  it('does not collide on near-identical ids', () => {
    const ids = ['a', 'b', 'aa', 'ab', 'ba', 'workspace-1', 'workspace-2']
    const seeds = new Set(ids.map(hashString))
    expect(seeds.size).toBe(ids.length)
  })
})

describe('base heightfield', () => {
  it('is deterministic: the same workspace always grows the same island', () => {
    const seed = terrainSeed('first-isle')
    const a = generateBaseHeightfield(seed, SMALL)
    const b = generateBaseHeightfield(seed, SMALL)
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('grows a different island for a different workspace', () => {
    const a = generateBaseHeightfield(terrainSeed('first-isle'), SMALL)
    const b = generateBaseHeightfield(terrainSeed('second-isle'), SMALL)

    // Measured over cells that are land in *either* island. Comparing against
    // the whole map instead would dilute the result with open ocean, which is
    // identically zero in both and says nothing about whether the seeds
    // actually produced different terrain.
    let differing = 0
    let considered = 0
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] <= 0 && b.data[i] <= 0) continue
      considered++
      if (Math.abs(a.data[i] - b.data[i]) > 1e-6) differing++
    }
    expect(considered).toBeGreaterThan(0)
    expect(differing / considered).toBeGreaterThan(0.5)
  })

  it('is an island, not a continent: the map border is open water', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), SMALL)
    for (let i = 0; i < SMALL; i++) {
      expect(f.data[i]).toBe(0)
      expect(f.data[(SMALL - 1) * SMALL + i]).toBe(0)
      expect(f.data[i * SMALL]).toBe(0)
      expect(f.data[i * SMALL + SMALL - 1]).toBe(0)
    }
  })

  it('normalises into [0, 1] with both ends used', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), SMALL)
    let min = Infinity
    let max = -Infinity
    for (const v of f.data) {
      expect(Number.isFinite(v)).toBe(true)
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeCloseTo(0, 5)
    expect(max).toBeCloseTo(1, 5)
  })

  it('leaves room for the sea rather than filling the map', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), 160)
    let land = 0
    for (const v of f.data) if (v > 0.004) land++
    const fraction = land / f.data.length
    expect(fraction).toBeGreaterThan(0.2)
    expect(fraction).toBeLessThan(0.7)
  })
})

describe('hydraulic erosion', () => {
  it('is deterministic for a given seed', () => {
    const seed = terrainSeed('first-isle')
    const a = erodeCPU(generateBaseHeightfield(seed, SMALL), seed, 3_000).field
    const b = erodeCPU(generateBaseHeightfield(seed, SMALL), seed, 3_000).field
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('actually changes the terrain', () => {
    const seed = terrainSeed('first-isle')
    const before = generateBaseHeightfield(seed, SMALL)
    const snapshot = Float32Array.from(before.data)
    const after = erodeCPU(before, seed, 4_000).field
    let changed = 0
    for (let i = 0; i < snapshot.length; i++) {
      if (Math.abs(snapshot[i] - after.data[i]) > 1e-5) changed++
    }
    expect(changed).toBeGreaterThan(0)
  })

  it('never produces NaN or negative height', () => {
    const seed = terrainSeed('first-isle')
    const f = erodeCPU(generateBaseHeightfield(seed, SMALL), seed, 4_000).field
    for (const v of f.data) {
      expect(Number.isNaN(v)).toBe(false)
      expect(v).toBeGreaterThanOrEqual(-1e-6)
    }
  })

  it('shares its droplet spawn stream with the GPU implementation', () => {
    // The CPU and GPU runs must start from byte-identical droplets, or the
    // benchmark is comparing two different simulations.
    const seed = terrainSeed('first-isle')
    const a = generateSpawns(seed, 32, SMALL)
    const b = generateSpawns(seed, 32, SMALL)
    expect(Array.from(a)).toEqual(Array.from(b))
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBeGreaterThanOrEqual(1)
      expect(a[i]).toBeLessThan(SMALL - 2)
    }
  })

  it('builds the same erosion brush on both paths', () => {
    const { offsets, weights } = buildBrushBuffers(2)
    expect(offsets.length).toBe(weights.length * 2)
    const total = weights.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 5)
  })
})

describe('terracing', () => {
  const seed = terrainSeed('first-isle')
  const field = normalise(erodeCPU(generateBaseHeightfield(seed, 128), seed, 8_000).field)
  const coarse = downsample(field, 64)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 2, 1)
  const t = terrace(smoothed, 12, 220, 46)

  it('keeps every band index inside the band count', () => {
    for (let i = 0; i < t.bands.length; i++) {
      expect(t.bands[i]).toBeLessThan(t.bandCount)
      if (!t.land[i]) expect(t.bands[i]).toBe(0)
    }
  })

  it('puts band zero at the waterline and the top band at the peak', () => {
    expect(bandHeight(0, 12, 46)).toBe(0)
    expect(bandHeight(11, 12, 46)).toBeCloseTo(46, 5)
  })

  it('samples ground height on the terrace, not between terraces', () => {
    const valid = new Set<number>()
    for (let b = 0; b < t.bandCount; b++) valid.add(bandHeight(b, t.bandCount, t.peakHeight))
    for (let i = 0; i < 200; i++) {
      const x = (Math.random() - 0.5) * t.worldSize
      const z = (Math.random() - 0.5) * t.worldSize
      const h = sampleGroundHeight(t, x, z)
      expect([...valid].some((v) => Math.abs(v - h) < 1e-4)).toBe(true)
    }
  })

  it('returns sea level outside the map rather than throwing', () => {
    expect(sampleGroundHeight(t, 99_999, 0)).toBe(0)
    expect(sampleGroundHeight(t, 0, -99_999)).toBe(0)
  })

  describe('mesh', () => {
    const geo = buildTerrainGeometry(t)

    it('emits complete triangles', () => {
      expect(geo.vertexCount).toBeGreaterThan(0)
      expect(geo.vertexCount % 3).toBe(0)
      expect(geo.normals.length).toBe(geo.positions.length)
      expect(geo.colors.length).toBe(geo.positions.length)
      expect(geo.vertexCount / 3).toBe(geo.topTriangles + geo.wallTriangles)
    })

    it('winds every face so its geometric normal matches its stored normal', () => {
      // Regression test. Reversing the two triangles of a cliff quad back-faces
      // every wall in the island; with front-face culling on they vanish and
      // the terraces render as dark holes. It is invisible in a unit test of
      // band indices and obvious here.
      const { positions, normals } = geo
      for (let tri = 0; tri < geo.vertexCount / 3; tri++) {
        const o = tri * 9
        const ax = positions[o], ay = positions[o + 1], az = positions[o + 2]
        const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5]
        const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8]

        const e1x = bx - ax, e1y = by - ay, e1z = bz - az
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az

        const nx = e1y * e2z - e1z * e2y
        const ny = e1z * e2x - e1x * e2z
        const nz = e1x * e2y - e1y * e2x

        const dot = nx * normals[o] + ny * normals[o + 1] + nz * normals[o + 2]
        expect(dot).toBeGreaterThan(0)
      }
    })

    it('never places geometry above the peak or below the sea floor', () => {
      for (let i = 1; i < geo.positions.length; i += 3) {
        expect(geo.positions[i]).toBeLessThanOrEqual(t.peakHeight + 1e-4)
        expect(geo.positions[i]).toBeGreaterThanOrEqual(-3.001)
      }
    })

    it('stays inside the world bounds', () => {
      const half = t.worldSize / 2
      for (let i = 0; i < geo.positions.length; i += 3) {
        expect(Math.abs(geo.positions[i])).toBeLessThanOrEqual(half + 1e-4)
        expect(Math.abs(geo.positions[i + 2])).toBeLessThanOrEqual(half + 1e-4)
      }
    })
  })
})

describe('field helpers', () => {
  it('downsamples to the requested size and preserves the range', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), 128)
    const d = downsample(f, 32)
    expect(d.size).toBe(32)
    expect(d.data.length).toBe(32 * 32)
    for (const v of d.data) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('refuses to upsample, returning the field untouched', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), 64)
    expect(downsample(f, 128)).toBe(f)
  })

  it('smoothing reduces local variation without shifting the mean much', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), 64)
    const before = Float32Array.from(f.data)
    const after = smoothField({ data: Float32Array.from(f.data), size: 64 }, 3, 1)

    const variation = (d: Float32Array, size: number) => {
      let sum = 0
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          sum += Math.abs(d[y * size + x] - d[y * size + x - 1])
        }
      }
      return sum
    }
    expect(variation(after.data, 64)).toBeLessThan(variation(before, 64))

    const mean = (d: Float32Array) => d.reduce((a, b) => a + b, 0) / d.length
    expect(Math.abs(mean(after.data) - mean(before))).toBeLessThan(0.03)
  })

  it('samples bilinearly inside the field and clamps outside it', () => {
    const f = generateBaseHeightfield(terrainSeed('first-isle'), 64)
    expect(Number.isFinite(sampleBilinear(f, 12.5, 20.25))).toBe(true)
    expect(sampleBilinear(f, -50, -50)).toBe(f.data[0])
  })
})

describe('config invariants', () => {
  it('keeps the terrace grid at or below the erosion grid', () => {
    // Terracing a *coarser* copy is the point; upsampling would invent detail
    // erosion never produced.
    expect(TERRAIN.terraceGrid).toBeLessThanOrEqual(TERRAIN.gridSize)
  })

  it('has at least two bands, or there is no terracing to speak of', () => {
    expect(TERRAIN.terraceBands).toBeGreaterThanOrEqual(2)
  })
})
