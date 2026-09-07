/// <reference lib="webworker" />
import { generateBaseHeightfield, downsample, normalise, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { terrace, buildTerrainGeometry } from '@/render/terrain/terrace'
import type {
  WorkerRequest, BaseResponse, TerrainRequest, TerrainResponse,
} from './terrainProtocol'

/**
 * The terrain pipeline, off the main thread.
 *
 * Phase 1's acceptance criterion is a full eroded island in under 400 ms
 * without stalling the interface, so nothing here touches the DOM and every
 * result crosses back as a transferable rather than a structured clone.
 */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  if (req.type === 'warm') {
    // Exercise every hot loop once on a toy island, then throw it away. The
    // shapes match the real pipeline so the same code paths get optimised.
    // Sized at roughly a quarter of a real island: V8 only promotes a loop
    // to its optimising tier after enough iterations, and a 64-cell toy left
    // the base generator interpreted when the real request arrived.
    const toy = generateBaseHeightfield(0x7a7a, 128)
    const eroded = normalise(erodeCPU(toy, 0x7a7a, 12_000, 28).field)
    const coarse = downsample(eroded, 52)
    const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, 1, 1)
    buildTerrainGeometry(terrace(smoothed, 6, 60, 8))
    return
  }
  if (req.type === 'base') {
    const t0 = performance.now()
    const field = generateBaseHeightfield(req.seed, req.erosionGrid)
    const response: BaseResponse = {
      type: 'base',
      heightfield: field.data,
      size: field.size,
      baseMs: performance.now() - t0,
    }
    self.postMessage(response, [response.heightfield.buffer])
    return
  }
  if (req.type === 'generate') {
    handleGenerate(req)
  }
}

function handleGenerate(req: TerrainRequest): void {
  const t0 = performance.now()

  let field
  let erosionMs: number
  let baseMs: number
  let backend: 'cpu' | 'gpu'

  if (req.preEroded) {
    field = normalise({ data: req.preEroded, size: req.erosionGrid })
    erosionMs = req.externalErosionMs ?? 0
    baseMs = 0
    backend = 'gpu'
  } else {
    const baseStart = performance.now()
    const base = generateBaseHeightfield(req.seed, req.erosionGrid)
    baseMs = performance.now() - baseStart
    const result = erodeCPU(base, req.seed, req.droplets)
    erosionMs = result.elapsedMs
    field = normalise(result.field)
    backend = 'cpu'
  }

  const { shape } = req

  const t2 = performance.now()
  // Terrace a smoothed copy. The unsmoothed field is kept for the shore blend
  // and for anything that needs the real post-erosion height.
  const coarse = downsample(field, shape.terraceGrid)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, shape.smoothing, 1)
  const terraced = terrace(smoothed, shape.bandCount, shape.worldSize, shape.peakHeight)
  const terraceMs = performance.now() - t2

  const t3 = performance.now()
  const geo = buildTerrainGeometry(terraced)
  const meshMs = performance.now() - t3

  const response: TerrainResponse = {
    type: 'terrain',
    positions: geo.positions,
    normals: geo.normals,
    colors: geo.colors,
    vertexCount: geo.vertexCount,
    topTriangles: geo.topTriangles,
    wallTriangles: geo.wallTriangles,
    bands: terraced.bands,
    land: terraced.land,
    terraceSize: terraced.size,
    bandCount: terraced.bandCount,
    worldSize: terraced.worldSize,
    peakHeight: terraced.peakHeight,
    heightfield: field.data,
    heightfieldSize: field.size,
    timings: {
      baseMs,
      erosionMs,
      terraceMs,
      meshMs,
      totalMs: performance.now() - t0,
      erosionBackend: backend,
    },
  }

  self.postMessage(response, [
    response.positions.buffer,
    response.normals.buffer,
    response.colors.buffer,
    response.bands.buffer,
    response.land.buffer,
    response.heightfield.buffer,
  ])
}
