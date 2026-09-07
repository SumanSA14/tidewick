import { OCEAN_SPECTRUM_WGSL, OCEAN_IFFT_WGSL, phillipsSpectrum } from './oceanFFT.wgsl'
import { mulberry32 } from '@/core/rng'

/**
 * The spectral ocean, run for real.
 *
 * `oceanFFT.wgsl.ts` - a Phillips spectrum animated by dispersion and a
 * Stockham inverse FFT - was naga-validated and never executed, for the same
 * reason as the other compute shaders: no adapter here, until a real Edge
 * window turned out to have one. This harness runs one full transform (the
 * spectrum pass, log2(N) butterfly passes per axis, the resolve pass), times it
 * across several time steps, and checks the result against a plain-JS inverse
 * DFT on a small grid, where O(N^4) is affordable and there is nothing to argue
 * with. Also a harness, not the product path: the sea that ships is the
 * Gerstner sum in `ocean.ts`, and this answers "does the transform run, is it
 * right, and what does a 256² frame cost".
 */

export interface FftPass {
  stride: number
  horizontal: boolean
}

/** The Stockham schedule: strides doubling along rows, then along columns. */
export function fftPassPlan(size: number): FftPass[] {
  if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
  const passes: FftPass[] = []
  for (const horizontal of [true, false]) {
    for (let stride = 1; stride < size; stride *= 2) passes.push({ stride, horizontal })
  }
  return passes
}

/**
 * What the shader computes, written the slow way: for every output cell, the
 * sum over every input cell with a positive-sign twiddle, then the 1/N² scale
 * and the checkerboard flip that recentres the patch. O(N^4); for tests only.
 */
export function naiveInverse2D(spectrum: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n * 2)
  const twoPi = Math.PI * 2
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let re = 0
      let im = 0
      for (let ky = 0; ky < n; ky++) {
        for (let kx = 0; kx < n; kx++) {
          const angle = (twoPi * ((kx * x) % n + ((ky * y) % n))) / n
          const c = Math.cos(angle)
          const s = Math.sin(angle)
          const a = spectrum[(ky * n + kx) * 2]
          const b = spectrum[(ky * n + kx) * 2 + 1]
          re += a * c - b * s
          im += a * s + b * c
        }
      }
      const flip = ((x + y) & 1) === 0 ? 1 : -1
      out[(y * n + x) * 2] = (re * flip) / (n * n)
      out[(y * n + x) * 2 + 1] = (im * flip) / (n * n)
    }
  }
  return out
}

/** The spectrum pass, in JS, to check the GPU's against. */
export function spectrumCPU(h0: Float32Array, n: number, patchMetres: number, time: number, gravity: number): Float32Array {
  const out = new Float32Array(n * n * 2)
  const w0 = (Math.PI * 2) / 200
  const half = n / 2
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const kx = ((x - half) * Math.PI * 2) / patchMetres
      const ky = ((y - half) * Math.PI * 2) / patchMetres
      const magnitude = Math.max(Math.hypot(kx, ky), 1e-6)
      const omega = Math.floor(Math.sqrt(gravity * magnitude) / w0) * w0 * time
      const c = Math.cos(omega)
      const s = Math.sin(omega)
      const i = (y * n + x) * 4
      const hkRe = h0[i], hkIm = h0[i + 1]
      const hmRe = h0[i + 2], hmIm = -h0[i + 3]
      // forward = hk * (c, s); backward = hMinusK * (c, -s)
      const fRe = hkRe * c - hkIm * s
      const fIm = hkRe * s + hkIm * c
      const bRe = hmRe * c + hmIm * s
      const bIm = -hmRe * s + hmIm * c
      out[(y * n + x) * 2] = fRe + bRe
      out[(y * n + x) * 2 + 1] = fIm + bIm
    }
  }
  return out
}

export interface OceanFFTResult {
  size: number
  iterations: number
  /** Milliseconds per full transform: spectrum + 2·log2(N) butterflies + resolve. */
  msPerTransform: number
  passes: number
  /** Largest |GPU - CPU| over the animated spectrum, checked on every run. */
  spectrumMaxError: number
  /** Largest |GPU - naive IDFT| over the height field; null above the size the naive check affords. */
  idftMaxError: number | null
  /** Largest |height| produced, so "zero everywhere" cannot pass as correct. */
  heightMaxAbs: number
  finite: boolean
}

const PATCH_METRES = 200
const GRAVITY = 9.81

export async function runOceanFFTGPU(device: GPUDevice, size = 256, iterations = 30, checkSize = 32): Promise<OceanFFTResult> {
  const run = async (n: number, iters: number, validate: boolean) => {
    const h0 = phillipsSpectrum(n, PATCH_METRES, 1, 0.35, 8, 0.0008, mulberry32(0x0cea))
    const cells = n * n

    const spectrumParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const h0Buffer = device.createBuffer({ size: h0.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(h0Buffer, 0, h0)
    const makeStorage = () => device.createBuffer({ size: cells * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    const bufA = makeStorage()
    const bufB = makeStorage()

    const spectrumModule = device.createShaderModule({ code: OCEAN_SPECTRUM_WGSL, label: 'ocean-spectrum' })
    const spectrumPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: spectrumModule, entryPoint: 'spectrumAt' } })
    const spectrumGroup = device.createBindGroup({
      layout: spectrumPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: spectrumParams } },
        { binding: 1, resource: { buffer: h0Buffer } },
        { binding: 2, resource: { buffer: bufA } },
      ],
    })

    const fftModule = device.createShaderModule({ code: OCEAN_IFFT_WGSL, label: 'ocean-ifft' })
    const butterfly = device.createComputePipeline({ layout: 'auto', compute: { module: fftModule, entryPoint: 'butterflyPass' } })
    const resolve = device.createComputePipeline({ layout: 'auto', compute: { module: fftModule, entryPoint: 'resolve' } })

    // One uniform + bind group per pass; the plan is static, so build once.
    const plan = fftPassPlan(n)
    const passGroups: Array<{ group: GPUBindGroup; src: GPUBuffer; dst: GPUBuffer }> = []
    let src = bufA
    let dst = bufB
    for (const p of plan) {
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(params, 0, new Uint32Array([n, p.stride, p.horizontal ? 1 : 0, 1]))
      const group = device.createBindGroup({
        layout: butterfly.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
        ],
      })
      passGroups.push({ group, src, dst })
      ;[src, dst] = [dst, src]
    }
    // After the butterflies the result sits in `src`; resolve writes it to `dst`.
    const resolveParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(resolveParams, 0, new Uint32Array([n, 1, 1, 1]))
    const resolveGroup = device.createBindGroup({
      layout: resolve.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: resolveParams } },
        { binding: 1, resource: { buffer: src } },
        { binding: 2, resource: { buffer: dst } },
      ],
    })
    const resultBuffer = dst

    const readback = device.createBuffer({ size: cells * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const spectrumReadback = device.createBuffer({ size: cells * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })

    const encodeTransform = (time: number, copyOut: boolean) => {
      const params = new ArrayBuffer(32)
      new Uint32Array(params)[0] = n
      const f = new Float32Array(params)
      f[1] = PATCH_METRES; f[2] = time; f[3] = 0.0008; f[4] = 1; f[5] = 0.35; f[6] = 8; f[7] = GRAVITY
      device.queue.writeBuffer(spectrumParams, 0, params)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(spectrumPipeline)
      pass.setBindGroup(0, spectrumGroup)
      pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8))
      pass.end()
      if (copyOut) encoder.copyBufferToBuffer(bufA, 0, spectrumReadback, 0, cells * 8)
      const fft = encoder.beginComputePass()
      fft.setPipeline(butterfly)
      for (const p of passGroups) {
        fft.setBindGroup(0, p.group)
        fft.dispatchWorkgroups(Math.ceil(n / 2 / 64), n)
      }
      fft.setPipeline(resolve)
      fft.setBindGroup(0, resolveGroup)
      fft.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8))
      fft.end()
      if (copyOut) encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, cells * 8)
      device.queue.submit([encoder.finish()])
    }

    // Warm up (pipeline compilation), then time.
    encodeTransform(0, false)
    await device.queue.onSubmittedWorkDone()
    const start = performance.now()
    for (let i = 0; i < iters; i++) encodeTransform(i * (1 / 30), false)
    await device.queue.onSubmittedWorkDone()
    const msPerTransform = (performance.now() - start) / iters

    // One validated transform at a fixed time.
    const time = 3.7
    encodeTransform(time, true)
    await readback.mapAsync(GPUMapMode.READ)
    const heights = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    await spectrumReadback.mapAsync(GPUMapMode.READ)
    const gpuSpectrum = new Float32Array(spectrumReadback.getMappedRange().slice(0))
    spectrumReadback.unmap()

    const cpuSpectrum = spectrumCPU(h0, n, PATCH_METRES, time, GRAVITY)
    let spectrumMaxError = 0
    for (let i = 0; i < cpuSpectrum.length; i++) spectrumMaxError = Math.max(spectrumMaxError, Math.abs(cpuSpectrum[i] - gpuSpectrum[i]))

    let idftMaxError: number | null = null
    if (validate) {
      const reference = naiveInverse2D(gpuSpectrum, n)
      idftMaxError = 0
      for (let i = 0; i < reference.length; i++) idftMaxError = Math.max(idftMaxError, Math.abs(reference[i] - heights[i]))
    }
    let heightMaxAbs = 0
    let finite = true
    for (let i = 0; i < heights.length; i += 2) {
      if (!Number.isFinite(heights[i])) finite = false
      heightMaxAbs = Math.max(heightMaxAbs, Math.abs(heights[i]))
    }

    for (const b of [spectrumParams, h0Buffer, bufA, bufB, resolveParams, readback, spectrumReadback]) b.destroy()
    return { msPerTransform, passes: plan.length + 2, spectrumMaxError, idftMaxError, heightMaxAbs, finite }
  }

  const timed = await run(size, iterations, size <= checkSize)
  const checked = size <= checkSize ? timed : await run(checkSize, 1, true)
  return {
    size,
    iterations,
    msPerTransform: timed.msPerTransform,
    passes: timed.passes,
    spectrumMaxError: Math.max(timed.spectrumMaxError, checked.spectrumMaxError),
    idftMaxError: checked.idftMaxError,
    heightMaxAbs: timed.heightMaxAbs,
    finite: timed.finite && checked.finite,
  }
}
