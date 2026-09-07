import { EROSION, TERRAIN } from '@/core/config'
import { mulberry32 } from '@/core/rng'
import type { Heightfield } from './heightfield'
import { EROSION_WGSL } from './erosion.wgsl'

/**
 * GPU droplet erosion on a standalone compute device.
 *
 * Deliberately independent of the renderer's backend. Erosion is a one-shot
 * job, not a per-frame pass, so it needs a GPUDevice and nothing else - no
 * canvas, no swap chain, no three.js. Two things fall out of that:
 *
 *   1. It still runs when the renderer has fallen back to WebGL2. Plenty of
 *      environments expose `navigator.gpu` for compute while failing to create
 *      a WebGPU *canvas context*; the Claude Code browser pane this was
 *      developed in is one of them. Tying erosion to the render backend would
 *      have thrown away a working GPU on those machines.
 *   2. It is testable in isolation, which is what makes the CPU-vs-GPU
 *      benchmark and the parity check possible at all.
 */

/** Fixed-point scale for the atomic heightmap. 2^20 keeps ~1e-6 of precision. */
const FIXED_SCALE = 1 << 20

export interface GPUErosionResult {
  field: Heightfield
  /** Milliseconds for the compute dispatch, excluding device acquisition. */
  elapsedMs: number
  /** Milliseconds spent uploading and reading back, which the CPU path avoids. */
  transferMs: number
  droplets: number
}

let devicePromise: Promise<GPUDevice | null> | null = null

/**
 * Acquire (and memoise) a compute-only WebGPU device, or null if unavailable.
 *
 * The memo is the *promise*, not a flag. The first version set an "attempted"
 * flag before awaiting the adapter, so a second caller arriving during that
 * await saw the flag, saw no device yet, and was told there was none. React's
 * StrictMode runs the boot effect twice in development, which made the
 * surviving Stage the second caller - and so the erosion shader never ran on
 * the GPU in the one browser on this machine that could run it, while the
 * benchmark called later from the console got a device every time. Sharing
 * the promise means every concurrent caller gets the same answer.
 */
export function getComputeDevice(): Promise<GPUDevice | null> {
  devicePromise ??= acquireComputeDevice()
  return devicePromise
}

async function acquireComputeDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    void device.lost.then(() => {
      // A lost device must not wedge the app: drop it and let the next call
      // try again, falling through to the CPU path if that fails too.
      devicePromise = null
    })
    return device
  } catch {
    return null
  }
}

/** Test seam: forget the memoised device so the next call acquires afresh. */
export function resetComputeDeviceForTests(): void {
  devicePromise = null
}

/**
 * Droplet spawn positions, generated on the CPU with the same seeded stream the
 * CPU implementation uses. Sharing them means a CPU run and a GPU run start
 * from byte-identical droplets, so any divergence between the two outputs is
 * attributable to GPU scheduling races and to nothing else.
 */
export function generateSpawns(seed: number, droplets: number, size: number): Float32Array {
  const rand = mulberry32(seed ^ 0x1b873593)
  const spawns = new Float32Array(droplets * 2)
  for (let i = 0; i < droplets; i++) {
    spawns[i * 2] = 1 + rand() * (size - 3)
    spawns[i * 2 + 1] = 1 + rand() * (size - 3)
  }
  return spawns
}

/** The same weighted disc the CPU path uses, flattened for upload. */
export function buildBrushBuffers(radius: number): { offsets: Int32Array; weights: Float32Array } {
  const offsets: number[] = []
  const weights: number[] = []
  let weightSum = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sqrDist = dx * dx + dy * dy
      if (sqrDist >= radius * radius) continue
      const w = 1 - Math.sqrt(sqrDist) / radius
      weightSum += w
      offsets.push(dx, dy)
      weights.push(w)
    }
  }
  const normalised = new Float32Array(weights.length)
  for (let i = 0; i < weights.length; i++) normalised[i] = weights[i] / weightSum
  return { offsets: new Int32Array(offsets), weights: normalised }
}

export async function erodeGPU(
  device: GPUDevice,
  field: Heightfield,
  seed: number,
  droplets = TERRAIN.dropletCount,
  lifetime = TERRAIN.dropletLifetime,
): Promise<GPUErosionResult> {
  const { size, data } = field
  const cellCount = size * size

  const transferStart = performance.now()

  // Heightmap as fixed-point i32, so droplets can accumulate with atomicAdd.
  const fixed = new Int32Array(cellCount)
  for (let i = 0; i < cellCount; i++) fixed[i] = Math.round(data[i] * FIXED_SCALE)

  const heightBuffer = device.createBuffer({
    size: fixed.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(heightBuffer, 0, fixed)

  const brush = buildBrushBuffers(EROSION.erosionRadius)
  const offsetsBuffer = makeStorageBuffer(device, brush.offsets)
  const weightsBuffer = makeStorageBuffer(device, brush.weights)

  const spawns = generateSpawns(seed, droplets, size)
  const spawnBuffer = makeStorageBuffer(device, spawns)

  // Params, laid out as four 16-byte rows to satisfy uniform alignment.
  const params = new ArrayBuffer(64)
  const u32 = new Uint32Array(params)
  const f32 = new Float32Array(params)
  u32[0] = size
  u32[1] = droplets
  u32[2] = lifetime
  u32[3] = brush.weights.length
  f32[4] = EROSION.inertia
  f32[5] = EROSION.sedimentCapacityFactor
  f32[6] = EROSION.minSedimentCapacity
  f32[7] = EROSION.erodeSpeed
  f32[8] = EROSION.depositSpeed
  f32[9] = EROSION.evaporateSpeed
  f32[10] = EROSION.gravity
  f32[11] = EROSION.initialWaterVolume
  f32[12] = EROSION.initialSpeed
  f32[13] = FIXED_SCALE

  const paramBuffer = device.createBuffer({
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(paramBuffer, 0, params)

  const module = device.createShaderModule({ code: EROSION_WGSL, label: 'droplet-erosion' })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: heightBuffer } },
      { binding: 1, resource: { buffer: paramBuffer } },
      { binding: 2, resource: { buffer: offsetsBuffer } },
      { binding: 3, resource: { buffer: weightsBuffer } },
      { binding: 4, resource: { buffer: spawnBuffer } },
    ],
  })

  const readback = device.createBuffer({
    size: fixed.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const transferMs = performance.now() - transferStart
  const computeStart = performance.now()

  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(droplets / 64))
  pass.end()
  encoder.copyBufferToBuffer(heightBuffer, 0, readback, 0, fixed.byteLength)
  device.queue.submit([encoder.finish()])

  await readback.mapAsync(GPUMapMode.READ)
  const elapsedMs = performance.now() - computeStart

  const out = new Int32Array(readback.getMappedRange().slice(0))
  readback.unmap()

  const result = new Float32Array(cellCount)
  for (let i = 0; i < cellCount; i++) result[i] = out[i] / FIXED_SCALE

  heightBuffer.destroy()
  offsetsBuffer.destroy()
  weightsBuffer.destroy()
  spawnBuffer.destroy()
  paramBuffer.destroy()
  readback.destroy()

  return {
    field: { data: result, size },
    elapsedMs,
    transferMs,
    droplets,
  }
}

function makeStorageBuffer(device: GPUDevice, data: Int32Array | Float32Array): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, data.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(buffer, 0, data)
  return buffer
}
