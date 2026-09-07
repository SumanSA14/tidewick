import { bandHeight, type TerracedField } from './terrace'

/**
 * The radial profile: for each angle around the isle, where the ground sits at
 * each elevation.
 *
 * This is what makes the elevation mechanic possible at all. A task's height is
 * a function of how long is left before it is due, and that changes every
 * second - so the island cannot store a plant's position, it has to *derive*
 * one continuously. Searching the heightfield per plant per frame on the CPU
 * would cost the whole frame budget.
 *
 * Instead the terrain is reduced once, at generation time, to a small table:
 * angle on one axis, normalised elevation on the other, and at each cell the
 * radius and ground height where that elevation occurs. The vertex shader then
 * places a plant with a single texture fetch, for whatever `now` happens to be,
 * and downhill drift becomes free rather than a simulation step.
 *
 * The table is built by walking rays outward from the centre. Because the isle
 * is a mound the ground generally falls as the radius grows, so for each target
 * elevation the *outermost* crossing is taken - a plant belongs on the seaward
 * face of the hill, not in some inland dip that happens to share its height.
 */

export interface RadialProfile {
  /** Angular samples around the isle. */
  angles: number
  /** Elevation samples from waterline (0) to peak (1). */
  levels: number
  /**
   * Interleaved [radius, height] per cell, row-major by angle.
   * Length is angles * levels * 2.
   */
  data: Float32Array
  /** World units from the centre to the furthest land, per angle. */
  maxRadius: Float32Array
  worldSize: number
  peakHeight: number
}

export const PROFILE_ANGLES = 64
export const PROFILE_LEVELS = 48

/** Rays are walked at this fraction of a cell, so no terrace is stepped over. */
const RAY_STEP_FACTOR = 0.5

export function buildRadialProfile(
  field: TerracedField,
  angles = PROFILE_ANGLES,
  levels = PROFILE_LEVELS,
): RadialProfile {
  const { size, bands, land, bandCount, cellSize, worldSize, peakHeight } = field
  const half = worldSize / 2
  const step = cellSize * RAY_STEP_FACTOR
  const maxSteps = Math.ceil(half / step)

  const data = new Float32Array(angles * levels * 2)
  const maxRadius = new Float32Array(angles)

  // Scratch for one ray: ground height sampled outward from the centre.
  const rayHeight = new Float32Array(maxSteps)
  const rayRadius = new Float32Array(maxSteps)

  for (let a = 0; a < angles; a++) {
    const theta = (a / angles) * Math.PI * 2
    const dx = Math.cos(theta)
    const dz = Math.sin(theta)

    let taken = 0
    for (let s = 0; s < maxSteps; s++) {
      const radius = s * step
      const wx = dx * radius
      const wz = dz * radius
      const gx = Math.floor(((wx + half) / worldSize) * size)
      const gz = Math.floor(((wz + half) / worldSize) * size)
      if (gx < 0 || gz < 0 || gx >= size || gz >= size) break

      const i = gz * size + gx
      if (!land[i]) {
        // Past the coastline on this ray. Everything beyond is sea.
        break
      }
      rayRadius[taken] = radius
      rayHeight[taken] = bandHeight(bands[i], bandCount, peakHeight)
      taken++
    }

    maxRadius[a] = taken > 0 ? rayRadius[taken - 1] : 0

    for (let l = 0; l < levels; l++) {
      // Level 0 is the waterline, level `levels - 1` is the peak.
      const target = (l / (levels - 1)) * peakHeight

      let radius = maxRadius[a]
      let height = 0
      let found = false

      // Outermost crossing: walk inward until the ground first reaches the
      // target. Walking outward instead would stop at the first inland dip of
      // the right height and plant things behind the ridge.
      for (let s = taken - 1; s >= 0; s--) {
        if (rayHeight[s] >= target) {
          radius = rayRadius[s]
          height = rayHeight[s]
          found = true
          break
        }
      }

      // Nothing on this ray reaches that high - the peak is elsewhere. Clamp to
      // the innermost sample so a far-future task still lands on land rather
      // than hovering over the sea.
      //
      // The flag matters. Testing `height === 0` instead looks equivalent and
      // is not: at the waterline the target *is* zero, the match is legitimate,
      // and its height is legitimately zero - so every task due today was
      // treated as unmatched and teleported to the middle of the island.
      if (!found && taken > 0) {
        radius = rayRadius[0]
        height = rayHeight[0]
      }

      const at = (a * levels + l) * 2
      data[at] = radius
      data[at + 1] = height
    }
  }

  return { angles, levels, data, maxRadius, worldSize, peakHeight }
}

/**
 * Sample the profile on the CPU, matching what the shader does.
 *
 * Exists so picking, tests and the Keeper in Phase 6 can agree with the GPU
 * about where a plant is. Bilinear across both axes, and the angle wraps.
 */
export function sampleProfile(
  profile: RadialProfile,
  angle: number,
  level: number,
): { radius: number; height: number } {
  const { angles, levels, data } = profile

  const twoPi = Math.PI * 2
  const wrapped = ((angle % twoPi) + twoPi) % twoPi
  const af = (wrapped / twoPi) * angles
  const a0 = Math.floor(af) % angles
  const a1 = (a0 + 1) % angles
  const at = af - Math.floor(af)

  const lf = Math.max(0, Math.min(1, level)) * (levels - 1)
  const l0 = Math.floor(lf)
  const l1 = Math.min(levels - 1, l0 + 1)
  const lt = lf - l0

  const read = (a: number, l: number, component: number) => data[(a * levels + l) * 2 + component]

  const lerp = (x: number, y: number, t: number) => x + (y - x) * t

  const radius = lerp(
    lerp(read(a0, l0, 0), read(a0, l1, 0), lt),
    lerp(read(a1, l0, 0), read(a1, l1, 0), lt),
    at,
  )
  const height = lerp(
    lerp(read(a0, l0, 1), read(a0, l1, 1), lt),
    lerp(read(a1, l0, 1), read(a1, l1, 1), lt),
    at,
  )

  return { radius, height }
}

/**
 * Pack the profile into an RGBA float texture payload.
 *
 * RG carries radius and height; BA are spare and currently zero. A two-channel
 * format would be tidier but RGBA is the one every backend supports without
 * asking questions, and the texture is 64x48 - the waste is 24 KB.
 */
export function profileToTexture(profile: RadialProfile): {
  data: Float32Array
  width: number
  height: number
} {
  const { angles, levels, data } = profile
  const out = new Float32Array(angles * levels * 4)
  for (let i = 0; i < angles * levels; i++) {
    out[i * 4] = data[i * 2]
    out[i * 4 + 1] = data[i * 2 + 1]
  }
  // Width is the elevation axis so a row is one angle, which is the order the
  // shader reads them in.
  return { data: out, width: levels, height: angles }
}
