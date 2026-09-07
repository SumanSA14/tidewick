import { generateBaseHeightfield, normalise, downsample, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { erodeGPU, getComputeDevice } from '@/render/terrain/erosionGPU'
import { terrace } from '@/render/terrain/terrace'
import { terrainSeed } from '@/core/hash'
import { runBoidsGPU, type BoidsGPUResult } from '@/render/boidsGPU'
import { runOceanFFTGPU, type OceanFFTResult } from '@/render/oceanFFTGPU'
import { TERRAIN } from '@/core/config'
import type { Stage } from '@/render/stage'

/**
 * The erosion benchmark, exposed on `window.__tidewick.bench()` in dev builds.
 *
 * The brief asks for a CPU-versus-GPU number in the README and is right to
 * insist it be measured. It also, quietly, asks a harder question that only
 * shows up once you actually run both: parallel droplet erosion is racy, so the
 * two implementations do not produce identical heightfields. This harness
 * reports the divergence alongside the timings, at three stages - raw height,
 * post-smoothing, and post-terracing - because the only one that matters to the
 * player is the last, and quantisation absorbs most of the noise before it.
 */

export interface BenchmarkResult {
  droplets: number
  grid: number
  cpuMs: number
  gpuMs: number | null
  gpuTransferMs: number | null
  speedup: number | null
  /** Mean absolute difference in normalised height, CPU vs GPU. */
  meanHeightDelta: number | null
  /** Largest single-cell height difference. */
  maxHeightDelta: number | null
  /** Percentage of terrace cells that land in a different band. */
  bandDisagreementPercent: number | null
  /** Percentage of cells where CPU and GPU disagree about land vs water. */
  landDisagreementPercent: number | null
  device: string
  note: string
}

export async function runErosionBenchmark(
  workspaceId = 'first-isle',
  droplets = TERRAIN.dropletCount,
): Promise<BenchmarkResult> {
  const seed = terrainSeed(workspaceId)
  const grid = TERRAIN.gridSize

  const cpuField = generateBaseHeightfield(seed, grid)
  const cpuRun = erodeCPU(cpuField, seed, droplets)
  const cpuNormalised = normalise({ data: cpuRun.field.data.slice(), size: grid })

  const device = await getComputeDevice()
  if (!device) {
    return {
      droplets,
      grid,
      cpuMs: cpuRun.elapsedMs,
      gpuMs: null,
      gpuTransferMs: null,
      speedup: null,
      meanHeightDelta: null,
      maxHeightDelta: null,
      bandDisagreementPercent: null,
      landDisagreementPercent: null,
      device: 'none',
      note: 'No WebGPU compute device. Erosion runs on the CPU in a worker.',
    }
  }

  // Fresh base field: the CPU run mutated its own copy in place.
  const gpuBase = generateBaseHeightfield(seed, grid)
  const gpuRun = await erodeGPU(device, gpuBase, seed, droplets)
  const gpuNormalised = normalise({ data: gpuRun.field.data.slice(), size: grid })

  let sum = 0
  let max = 0
  for (let i = 0; i < cpuNormalised.data.length; i++) {
    const d = Math.abs(cpuNormalised.data[i] - gpuNormalised.data[i])
    sum += d
    if (d > max) max = d
  }

  // The comparison that actually matters: after downsampling, smoothing and
  // quantising, how many terrace cells end up in a different band?
  const terraceOf = (f: { data: Float32Array; size: number }) => {
    const coarse = downsample(f, 104)
    const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, TERRAIN.terraceSmoothing, 1)
    return terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)
  }
  const cpuT = terraceOf(cpuNormalised)
  const gpuT = terraceOf(gpuNormalised)

  let bandDiff = 0
  let landDiff = 0
  let landCells = 0
  for (let i = 0; i < cpuT.bands.length; i++) {
    if (cpuT.land[i] !== gpuT.land[i]) landDiff++
    if (!cpuT.land[i] || !gpuT.land[i]) continue
    landCells++
    if (cpuT.bands[i] !== gpuT.bands[i]) bandDiff++
  }

  return {
    droplets,
    grid,
    cpuMs: cpuRun.elapsedMs,
    gpuMs: gpuRun.elapsedMs,
    gpuTransferMs: gpuRun.transferMs,
    speedup: cpuRun.elapsedMs / gpuRun.elapsedMs,
    meanHeightDelta: sum / cpuNormalised.data.length,
    maxHeightDelta: max,
    bandDisagreementPercent: landCells > 0 ? (bandDiff / landCells) * 100 : 0,
    landDisagreementPercent: (landDiff / cpuT.land.length) * 100,
    device: 'webgpu',
    note: 'GPU droplets race by construction; band disagreement is what survives terracing.',
  }
}

declare global {
  interface Window {
    __tidewick?: {
      bench: typeof runErosionBenchmark
      stage: Stage | null
      frames: (count?: number) => Promise<unknown>
      /** Synchronous CPU-submit / serialised-GPU benchmark; no visible window needed. */
      submit: (count?: number) => unknown
      /** Cold-start marks, in ms since navigation start. */
      boot: () => { interactiveMs: number | null; islandMs: number | null }
      /** The compute flock, stepped on the standalone device. */
      boids: (agents?: number, steps?: number) => Promise<BoidsGPUResult | string>
      /** The spectral ocean: one full transform, timed and checked. */
      fft: (size?: number, iterations?: number) => Promise<OceanFFTResult | string>
      hour: (h: number | null) => string
    }
  }
}

/**
 * Both entry points create the namespace if it is missing, because they are
 * reached through two independent dynamic imports whose resolution order is not
 * guaranteed. Requiring one to have run first is a race that shows up as a
 * benchmark that silently reports "no stage".
 */
function namespace(): NonNullable<Window['__tidewick']> {
  if (!window.__tidewick) {
    window.__tidewick = {
      bench: runErosionBenchmark,
      stage: null,
      frames: async (count = 120) => window.__tidewick?.stage?.benchmarkFrames(count) ?? 'no stage',
      submit: (count = 120) => window.__tidewick?.stage?.benchmarkSubmit(count) ?? 'no stage',
      boot: () => {
        const mark = (name: string) => performance.getEntriesByName(name)[0]?.startTime ?? null
        return { interactiveMs: mark('tidewick:interactive'), islandMs: mark('tidewick:island') }
      },
      boids: async (agents = 50_000, steps = 60) => {
        const device = await getComputeDevice()
        return device ? runBoidsGPU(device, agents, steps) : 'no compute device'
      },
      fft: async (size = 256, iterations = 30) => {
        const device = await getComputeDevice()
        return device ? runOceanFFTGPU(device, size, iterations) : 'no compute device'
      },
      hour: (h) => {
        window.__tidewick?.stage?.pinHour(h)
        return h === null ? 'released to real time' : `pinned to ${h}:00`
      },
    }
  }
  return window.__tidewick
}

export function installDevTools(): void {
  namespace()
}

export function registerStage(stage: Stage): void {
  namespace().stage = stage
}
