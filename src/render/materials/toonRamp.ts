import { DataTexture, RGBAFormat, NearestFilter, ClampToEdgeWrapping, SRGBColorSpace } from 'three'

/**
 * Cel-band gradient ramp.
 *
 * Nearest filtering is the whole trick: a linearly-filtered ramp is just
 * Lambert with extra steps. Hard steps between bands are what makes the
 * shading read as ink-and-paint rather than as a smooth 3D render.
 *
 * One ramp per material family, so terrain, foliage and the Keeper can each
 * have their own light response without a shader variant per object.
 */
export function makeToonRamp(stops: number[]): DataTexture {
  const width = stops.length
  const data = new Uint8Array(width * 4)
  for (let i = 0; i < width; i++) {
    const v = Math.round(Math.max(0, Math.min(1, stops[i])) * 255)
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  const tex = new DataTexture(data, width, 1, RGBAFormat)
  tex.magFilter = NearestFilter
  tex.minFilter = NearestFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.colorSpace = SRGBColorSpace
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

/**
 * Three bands for terrain. The shadow band is lifted well off black because
 * nothing in this product is allowed to feel harsh, and a crushed shadow on a
 * grass plateau reads as a bruise.
 */
export const TERRAIN_RAMP_STOPS = [0.72, 0.94, 1.0]

/** Two bands, tighter contrast, for props and the Keeper. */
export const PROP_RAMP_STOPS = [0.70, 1.0]
