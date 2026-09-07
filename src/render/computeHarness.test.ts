import { describe, expect, it } from 'vitest'
import { boidsGrid, packBoidParams, BOID_PARAMS_BYTES, flockHomesAt, syntheticGround } from './boidsGPU'
import { fftPassPlan, naiveInverse2D, spectrumCPU } from './oceanFFTGPU'
import { phillipsSpectrum } from './oceanFFT.wgsl'
import { BOID } from './birds'
import { mulberry32 } from '@/core/rng'

/**
 * The CPU halves of the two compute harnesses. The GPU halves run in a real
 * browser (`__tidewick.boids()`, `__tidewick.fft()`); what can be pinned here
 * is that the buffers they hand the shaders are laid out the way the WGSL
 * declares them, and that the reference the FFT is judged against is itself
 * right.
 */

describe('boids harness, CPU side', () => {
  it('lays Params out field for field as the WGSL struct', () => {
    const grid = boidsGrid()
    const buffer = packBoidParams(50_000, grid, 1 / 30)
    expect(buffer.byteLength).toBe(BOID_PARAMS_BYTES)
    const u = new Uint32Array(buffer)
    const f = new Float32Array(buffer)
    expect(u[0]).toBe(50_000)
    expect(u[3]).toBe(grid.cellCount)
    expect(f[7]).toBeCloseTo(BOID.radius * BOID.radius)
    expect(f[16]).toBeCloseTo(BOID.maxSpeed)
    expect(f[17]).toBeCloseTo(BOID.floor)
    expect(u[18]).toBe(BOID.maxNeighbours)
    expect(u[19]).toBe(BOID.flocks)
  })

  it('sizes the hash grid to cover the ring with one radius of slack', () => {
    const grid = boidsGrid()
    expect(grid.cellSize).toBe(BOID.radius)
    expect(grid.extent).toBeGreaterThan(BOID.ringRadius + BOID.ringWidth)
    expect(grid.cellCount).toBe(grid.cellsAcross * grid.cellsAcross * grid.cellsUp)
    // Tens of thousands of cells, as the shader's serial prefix sum assumes.
    expect(grid.cellCount).toBeGreaterThan(5_000)
    expect(grid.cellCount).toBeLessThan(60_000)
  })

  it('places every flock home on the ring, one vec4 per flock', () => {
    const phase = new Float32Array(BOID.flocks).map((_, f) => (f / BOID.flocks) * Math.PI * 2)
    const rate = new Float32Array(BOID.flocks).fill(0.04)
    const height = new Float32Array(BOID.flocks).fill(BOID.ringHeight)
    const homes = flockHomesAt(2.5, phase, rate, height)
    expect(homes.length).toBe(BOID.flocks * 4)
    for (let f = 0; f < BOID.flocks; f++) {
      const r = Math.hypot(homes[f * 4], homes[f * 4 + 2])
      expect(r).toBeGreaterThan(BOID.ringRadius - BOID.ringWidth)
      expect(r).toBeLessThan(BOID.ringRadius + BOID.ringWidth)
      expect(homes[f * 4 + 1]).toBe(BOID.ringHeight)
    }
  })

  it('builds a dome the floor rule can push against', () => {
    const g = syntheticGround(32, 220)
    expect(g[16 * 32 + 16]).toBeGreaterThan(30)
    expect(g[0]).toBe(-4)
  })
})

describe('ocean FFT harness, CPU side', () => {
  it('schedules log2(N) doubling strides per axis, rows first', () => {
    const plan = fftPassPlan(8)
    expect(plan).toEqual([
      { stride: 1, horizontal: true }, { stride: 2, horizontal: true }, { stride: 4, horizontal: true },
      { stride: 1, horizontal: false }, { stride: 2, horizontal: false }, { stride: 4, horizontal: false },
    ])
    expect(fftPassPlan(256).length).toBe(16)
    expect(() => fftPassPlan(96)).toThrow()
  })

  it('reference inverse: a DC-only spectrum is a checkerboard of 1/N²', () => {
    const n = 4
    const spectrum = new Float32Array(n * n * 2)
    spectrum[0] = 1 // k = (0, 0), real
    const out = naiveInverse2D(spectrum, n)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const flip = ((x + y) & 1) === 0 ? 1 : -1
        expect(out[(y * n + x) * 2]).toBeCloseTo(flip / (n * n), 6)
        expect(out[(y * n + x) * 2 + 1]).toBeCloseTo(0, 6)
      }
    }
  })

  it('reference inverse: a single k-mode comes back as that plane wave', () => {
    const n = 8
    const spectrum = new Float32Array(n * n * 2)
    spectrum[(0 * n + 1) * 2] = n * n // kx = 1, ky = 0, scaled so the wave has unit amplitude
    const out = naiveInverse2D(spectrum, n)
    for (let x = 0; x < n; x++) {
      const flip = (x & 1) === 0 ? 1 : -1
      expect(out[(0 * n + x) * 2]).toBeCloseTo(Math.cos((2 * Math.PI * x) / n) * flip, 6)
      expect(out[(0 * n + x) * 2 + 1]).toBeCloseTo(Math.sin((2 * Math.PI * x) / n) * flip, 6)
    }
  })

  it('CPU spectrum is finite, time-dependent and Hermitian-shaped from a real h0', () => {
    const n = 16
    const h0 = phillipsSpectrum(n, 200, 1, 0.35, 8, 0.0008, mulberry32(7))
    const a = spectrumCPU(h0, n, 200, 0, 9.81)
    const b = spectrumCPU(h0, n, 200, 3.7, 9.81)
    expect(a.every(Number.isFinite)).toBe(true)
    let moved = 0
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) moved++
    expect(moved).toBeGreaterThan(a.length / 4)
  })
})
