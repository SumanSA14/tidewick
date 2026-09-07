/** Messages exchanged with the terrain worker. Shared by both sides. */

export interface TerrainShape {
  bandCount: number
  worldSize: number
  peakHeight: number
  /** Blur passes applied before quantising. This is the plateau-width dial. */
  smoothing: number
  /** Resolution the terraces are meshed at. Lower = chunkier plateaus. */
  terraceGrid: number
}

/**
 * Generate a base heightfield and stop, so the caller can erode it on the GPU.
 *
 * The split exists because erosion is the only stage that can profitably leave
 * the worker: it needs a GPUDevice, and a GPUDevice lives on whichever thread
 * acquired it. Base generation and meshing stay here regardless of path, so
 * there is exactly one implementation of each rather than a worker copy and a
 * main-thread copy that quietly diverge.
 */
export interface BaseRequest {
  type: 'base'
  seed: number
  erosionGrid: number
}

export interface BaseResponse {
  type: 'base'
  heightfield: Float32Array
  size: number
  baseMs: number
}

export interface TerrainRequest {
  type: 'generate'
  seed: number
  /** Resolution the erosion runs at. Higher = finer drainage channels. */
  erosionGrid: number
  droplets: number
  shape: TerrainShape
  /**
   * When the GPU has already eroded the field, it is passed in here and the
   * worker skips straight to terracing.
   */
  preEroded?: Float32Array
  /** Timing attributed to the caller's GPU erosion, for the HUD. */
  externalErosionMs?: number
}

/**
 * Warm the worker's JIT before the first real island is asked for.
 *
 * A fresh worker runs the erosion loop cold, and in the browser that costs
 * 80-120 ms of interpreter and baseline-JIT time before the optimising tier
 * kicks in - the single largest reason the CPU path missed its 400 ms budget.
 * A small throwaway erosion during renderer initialisation, which is idle
 * time anyway, gets the hot loops compiled for free.
 */
export interface WarmRequest {
  type: 'warm'
}

export type WorkerRequest = BaseRequest | TerrainRequest | WarmRequest
export type WorkerResponse = BaseResponse | TerrainResponse

export interface TerrainTimings {
  baseMs: number
  erosionMs: number
  terraceMs: number
  meshMs: number
  totalMs: number
  erosionBackend: 'cpu' | 'gpu'
}

export interface TerrainResponse {
  type: 'terrain'
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  vertexCount: number
  topTriangles: number
  wallTriangles: number
  /** Kept for ground sampling, plant placement and, later, the Keeper. */
  bands: Uint8Array
  land: Uint8Array
  terraceSize: number
  bandCount: number
  worldSize: number
  peakHeight: number
  /** The continuous post-erosion field, for the ocean shore blend. */
  heightfield: Float32Array
  heightfieldSize: number
  timings: TerrainTimings
}
