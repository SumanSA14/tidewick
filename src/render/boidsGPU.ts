import { BOIDS_WGSL } from './boids.wgsl'
import { BOID } from './birds'
import { mulberry32 } from '@/core/rng'
import { TERRAIN } from '@/core/config'

/**
 * The compute flock, run for real.
 *
 * `boids.wgsl.ts` was written against Section 9's 50k-agent budget and, like
 * every compute shader in this project, checked with naga rather than run,
 * because no machine here exposed a WebGPU adapter to the browser this was
 * developed in. A real Edge window does, so this harness builds the twelve
 * bindings, the four pipelines and a ping-pong of state, steps the flock, and
 * reads it back to check it is still a flock: finite, inside the speed band,
 * near the isle. The timing is per step for the whole four-dispatch chain.
 *
 * It is a harness, not the product path. The drawn flock is `birds.ts` on the
 * CPU at 120-1,600 agents; this answers the budget's question - can this GPU
 * step 50,000 agents inside a frame - with a measurement.
 */

export interface BoidsGrid {
  cellSize: number
  extent: number
  cellsAcross: number
  cellsUp: number
  cellCount: number
}

export interface BoidsGPUResult {
  agents: number
  steps: number
  cells: number
  /** Wall time from the first submit to the queue reporting all steps done. */
  totalMs: number
  msPerStep: number
  /** Buffers and pipelines, not counted in the steps. */
  setupMs: number
  finite: boolean
  /** Fraction of agents inside [minSpeed, maxSpeed] after the last step. */
  speedInBand: number
  /** Furthest agent from the isle's centre, metres. */
  maxRadius: number
  /** Mean distance from each agent to its flock's home - small means flocks held. */
  meanHomeDistance: number
}

/**
 * The hash grid. Cells are one neighbour radius wide, so a neighbour search
 * is the 27 surrounding cells; the extent covers the ring plus its width with
 * a cell of slack, and the height covers the ring height plus the roaming the
 * floor rule and the spring allow.
 */
export function boidsGrid(
  radius: number = BOID.radius,
  extent: number = BOID.ringRadius + BOID.ringWidth + BOID.radius,
  height: number = BOID.ringHeight + 70,
): BoidsGrid {
  const cellsAcross = Math.ceil((extent * 2) / radius)
  const cellsUp = Math.ceil(height / radius)
  return { cellSize: radius, extent, cellsAcross, cellsUp, cellCount: cellsAcross * cellsAcross * cellsUp }
}

/** Size of the `Params` uniform: 22 four-byte fields, rounded up to 16 bytes. */
export const BOID_PARAMS_BYTES = 96

/** Lay out `Params` exactly as the WGSL declares it - scalar fields in order. */
export function packBoidParams(count: number, grid: BoidsGrid, dt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(BOID_PARAMS_BYTES)
  const u = new Uint32Array(buffer)
  const f = new Float32Array(buffer)
  u[0] = count
  u[1] = grid.cellsAcross
  u[2] = grid.cellsUp
  u[3] = grid.cellCount
  f[4] = grid.cellSize
  f[5] = grid.extent
  f[6] = dt
  f[7] = BOID.radius * BOID.radius
  f[8] = BOID.separation
  f[9] = BOID.alignment
  f[10] = BOID.cohesion
  f[11] = BOID.ring
  f[12] = BOID.ringRadius
  f[13] = BOID.ringHeight
  f[14] = BOID.ringWidth
  f[15] = BOID.minSpeed
  f[16] = BOID.maxSpeed
  f[17] = BOID.floor
  u[18] = BOID.maxNeighbours
  u[19] = BOID.flocks
  return buffer
}

/** The same per-flock drifting homes `birds.ts` steers toward, for one clock value. */
export function flockHomesAt(clock: number, phase: Float32Array, rate: Float32Array, height: Float32Array): Float32Array {
  const out = new Float32Array(BOID.flocks * 4)
  for (let f = 0; f < BOID.flocks; f++) {
    const a = phase[f] + clock * rate[f]
    const r = BOID.ringRadius + Math.sin(clock * 0.11 + f) * BOID.ringWidth * 0.35
    out[f * 4] = Math.cos(a) * r
    out[f * 4 + 1] = height[f]
    out[f * 4 + 2] = Math.sin(a) * r
  }
  return out
}

/** A dome for the floor rule to push against: the isle is roughly this shape. */
export function syntheticGround(size: number, worldSize: number): Float32Array {
  const heights = new Float32Array(size * size)
  const half = worldSize / 2
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const wx = (x / size) * worldSize - half
      const wz = (z / size) * worldSize - half
      const d = Math.hypot(wx, wz)
      heights[z * size + x] = Math.max(-4, 40 - d / 2.5)
    }
  }
  return heights
}

function storage(device: GPUDevice, data: ArrayBufferView | ArrayBuffer, extraUsage = 0): GPUBuffer {
  const bytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength
  const buffer = device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage })
  device.queue.writeBuffer(buffer, 0, data as BufferSource)
  return buffer
}

export async function runBoidsGPU(device: GPUDevice, agents = 50_000, steps = 60, dt = 1 / BOID.hz, seed = 0x5eed): Promise<BoidsGPUResult> {
  const setupStart = performance.now()
  const grid = boidsGrid()
  const rand = mulberry32(seed)

  // Flock homes, seeded the way birds.ts seeds them.
  const phase = new Float32Array(BOID.flocks)
  const rate = new Float32Array(BOID.flocks)
  const height = new Float32Array(BOID.flocks)
  for (let f = 0; f < BOID.flocks; f++) {
    phase[f] = (f / BOID.flocks) * Math.PI * 2 + rand() * 0.6
    rate[f] = 0.035 + rand() * 0.03
    height[f] = BOID.ringHeight + (rand() - 0.5) * 22
  }

  // Spawn with the flock, as birds.ts does.
  const pos = new Float32Array(agents * 4)
  const vel = new Float32Array(agents * 4)
  for (let i = 0; i < agents; i++) {
    const f = i % BOID.flocks
    const a = phase[f] + (rand() - 0.5) * 0.35
    const r = BOID.ringRadius + (rand() - 0.5) * BOID.ringWidth * 0.6
    pos[i * 4] = Math.cos(a) * r
    pos[i * 4 + 1] = height[f] + (rand() - 0.5) * 10
    pos[i * 4 + 2] = Math.sin(a) * r
    const heading = rand() * Math.PI * 2
    const speed = (BOID.minSpeed + BOID.maxSpeed) / 2
    vel[i * 4] = Math.cos(heading) * speed
    vel[i * 4 + 2] = Math.sin(heading) * speed
  }

  const groundSize = 64
  const heights = syntheticGround(groundSize, TERRAIN.worldSize)
  const groundParams = new ArrayBuffer(16)
  new Uint32Array(groundParams)[0] = groundSize
  new Float32Array(groundParams)[1] = TERRAIN.worldSize

  const paramsBuffer = device.createBuffer({ size: BOID_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(paramsBuffer, 0, packBoidParams(agents, grid, dt))
  const groundBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(groundBuffer, 0, groundParams)

  const posA = storage(device, pos, GPUBufferUsage.COPY_SRC)
  const velA = storage(device, vel, GPUBufferUsage.COPY_SRC)
  const posB = storage(device, new Float32Array(agents * 4), GPUBufferUsage.COPY_SRC)
  const velB = storage(device, new Float32Array(agents * 4), GPUBufferUsage.COPY_SRC)
  const cellCounts = storage(device, new Uint32Array(grid.cellCount))
  const cellStarts = storage(device, new Uint32Array(grid.cellCount + 1))
  const cellCursors = storage(device, new Uint32Array(grid.cellCount))
  const sorted = storage(device, new Uint32Array(agents))
  const heightsBuffer = storage(device, heights)
  const homesBuffer = storage(device, flockHomesAt(0, phase, rate, height))

  // One explicit layout for all four entry points: with `layout: 'auto'` each
  // pipeline would only accept the bindings it happens to read.
  const ro: GPUBufferBindingType = 'read-only-storage'
  const rw: GPUBufferBindingType = 'storage'
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: ro } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: ro } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: rw } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: ro } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: ro } },
    ],
  })
  const module = device.createShaderModule({ code: BOIDS_WGSL, label: 'boids' })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
  const make = (entryPoint: string) => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } })
  const count = make('countCells')
  const prefix = make('prefixSum')
  const scatter = make('scatter')
  const steer = make('steer')

  const bindGroup = (pIn: GPUBuffer, vIn: GPUBuffer, pOut: GPUBuffer, vOut: GPUBuffer) => device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: pIn } },
      { binding: 2, resource: { buffer: vIn } },
      { binding: 3, resource: { buffer: pOut } },
      { binding: 4, resource: { buffer: vOut } },
      { binding: 5, resource: { buffer: cellCounts } },
      { binding: 6, resource: { buffer: cellStarts } },
      { binding: 7, resource: { buffer: cellCursors } },
      { binding: 8, resource: { buffer: sorted } },
      { binding: 9, resource: { buffer: groundBuffer } },
      { binding: 10, resource: { buffer: heightsBuffer } },
      { binding: 11, resource: { buffer: homesBuffer } },
    ],
  })
  const groups = [bindGroup(posA, velA, posB, velB), bindGroup(posB, velB, posA, velA)]
  const setupMs = performance.now() - setupStart

  const workgroups = Math.ceil(agents / 256)
  const start = performance.now()
  for (let step = 0; step < steps; step++) {
    device.queue.writeBuffer(homesBuffer, 0, flockHomesAt(step * dt, phase, rate, height))
    const encoder = device.createCommandEncoder()
    encoder.clearBuffer(cellCounts)
    const pass = encoder.beginComputePass()
    pass.setBindGroup(0, groups[step % 2])
    pass.setPipeline(count)
    pass.dispatchWorkgroups(workgroups)
    pass.setPipeline(prefix)
    pass.dispatchWorkgroups(1)
    pass.setPipeline(scatter)
    pass.dispatchWorkgroups(workgroups)
    pass.setPipeline(steer)
    pass.dispatchWorkgroups(workgroups)
    pass.end()
    device.queue.submit([encoder.finish()])
  }
  await device.queue.onSubmittedWorkDone()
  const totalMs = performance.now() - start

  // Read the final state back: after an even number of steps it is in A.
  const finalPos = steps % 2 === 0 ? posA : posB
  const finalVel = steps % 2 === 0 ? velA : velB
  const read = async (src: GPUBuffer) => {
    const readback = device.createBuffer({ size: agents * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(src, 0, readback, 0, agents * 16)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const data = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    readback.destroy()
    return data
  }
  const outPos = await read(finalPos)
  const outVel = await read(finalVel)
  const homes = flockHomesAt(steps * dt, phase, rate, height)

  let finite = true
  let inBand = 0
  let maxRadius = 0
  let homeDistance = 0
  for (let i = 0; i < agents; i++) {
    const x = outPos[i * 4], y = outPos[i * 4 + 1], z = outPos[i * 4 + 2]
    const vx = outVel[i * 4], vy = outVel[i * 4 + 1], vz = outVel[i * 4 + 2]
    if (![x, y, z, vx, vy, vz].every(Number.isFinite)) { finite = false; continue }
    const speed = Math.hypot(vx, vy, vz)
    if (speed >= BOID.minSpeed - 1e-3 && speed <= BOID.maxSpeed + 1e-3) inBand++
    maxRadius = Math.max(maxRadius, Math.hypot(x, z))
    const f = (i % BOID.flocks) * 4
    homeDistance += Math.hypot(x - homes[f], y - homes[f + 1], z - homes[f + 2])
  }

  for (const b of [posA, velA, posB, velB, cellCounts, cellStarts, cellCursors, sorted, heightsBuffer, homesBuffer, paramsBuffer, groundBuffer]) b.destroy()

  return {
    agents,
    steps,
    cells: grid.cellCount,
    totalMs,
    msPerStep: totalMs / steps,
    setupMs,
    finite,
    speedInBand: inBand / agents,
    maxRadius,
    meanHomeDistance: homeDistance / agents,
  }
}
