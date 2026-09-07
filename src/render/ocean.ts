import {
  Mesh, PlaneGeometry, DataTexture, RedFormat, FloatType, LinearFilter,
  ClampToEdgeWrapping, Color, DoubleSide,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  positionLocal, texture, uniform, vec2, vec3, float, mix, smoothstep, clamp,
  sin, cos, normalize, dot, max, pow, Fn,
} from 'three/tsl'
import { motionTime } from './motion'
import type { DaylightState } from '@/core/daylight'

/**
 * The sea, and specifically the shore.
 *
 * A flat plane of one blue is what made the island look like a model on a
 * table. Real coastal water is legible in two ways at once - it goes pale over
 * shallows and it breaks white where it meets land - and both are readable at
 * diorama distance, which is the only distance this camera ever uses.
 *
 * Rather than simulate any of it, the worker hands over a blurred land mask and
 * the shader reads shallowness straight out of it. Phase 5 replaces the surface
 * with the spectral FFT ocean; the shore blend it needs is this same field, so
 * building it now is not throwaway work.
 */
export interface Ocean {
  mesh: Mesh
  /** Feed the post-erosion heightfield so the shore knows where the land is. */
  setLandField(field: Float32Array, size: number): void
  apply(state: DaylightState, water: Color, deep: Color, foam: Color): void
  dispose(): void
}

/** Extent of the sea plane, as a multiple of the island's world size. */
const SEA_SPAN = 4

/**
 * Tessellation of the sea. Gerstner displacement happens per vertex, so this is
 * the only thing that decides how smooth a wave looks - and 128 segments over
 * four island-widths is about 2 m per quad, which is finer than the swell.
 */
const SEA_SEGMENTS = 128

/**
 * Gerstner wave components: direction, wavelength, amplitude, speed, steepness.
 *
 * Four is enough. The point of summing several is that their interference
 * breaks the obvious periodicity, and past four the extra terms cost vertex
 * time without changing the silhouette. Directions are deliberately not
 * parallel or perpendicular, so the pattern never resolves into a grid.
 *
 * Phase 8 swaps this for the spectral FFT ocean on the WebGPU path (see
 * `oceanFFT.wgsl.ts`); Gerstner remains the WebGL2 fallback, because WebGL2
 * has no compute shaders and an IFFT via ping-pong framebuffers is not worth
 * what it costs.
 */
const WAVES = [
  { dx: 1.0, dz: 0.15, length: 62, amplitude: 0.55, speed: 0.55, steepness: 0.32 },
  { dx: -0.4, dz: 0.92, length: 41, amplitude: 0.34, speed: 0.72, steepness: 0.28 },
  { dx: 0.72, dz: -0.68, length: 23, amplitude: 0.19, speed: 0.95, steepness: 0.24 },
  { dx: -0.86, dz: -0.5, length: 13, amplitude: 0.09, speed: 1.25, steepness: 0.18 },
]

export function createOcean(worldSize: number, seaLevelY: number): Ocean {
  const geometry = new PlaneGeometry(
    worldSize * SEA_SPAN, worldSize * SEA_SPAN, SEA_SEGMENTS, SEA_SEGMENTS,
  )
  geometry.rotateX(-Math.PI / 2)

  // One-pixel placeholder so the material compiles before terrain arrives.
  let landTexture = makeLandTexture(new Float32Array([0]), 1)

  const uLand = texture(landTexture)
  const uShallow = uniform(new Color(0x4fc3c7))
  const uDeep = uniform(new Color(0x1b6f8c))
  const uFoam = uniform(new Color(0xf4fbff))
  const uLit = uniform(1)

  // Map the plane's local XZ into the heightfield's [0,1] UV. The plane is
  // SEA_SPAN times wider than the island, so the island occupies the middle
  // 1/SEA_SPAN of it and everything outside samples the clamped border, which
  // is open water.
  const half = worldSize * SEA_SPAN * 0.5
  const uvNode = vec2(
    positionLocal.x.add(half).div(worldSize * SEA_SPAN).sub(0.5).mul(SEA_SPAN).add(0.5),
    positionLocal.z.add(half).div(worldSize * SEA_SPAN).sub(0.5).mul(SEA_SPAN).add(0.5),
  )

  const landiness = clamp(uLand.sample(uvNode).r, float(0), float(1))

  /**
   * Land mask at an arbitrary local XZ, for damping the swell near shore.
   *
   * Takes two scalars rather than a vec2 so it accepts a swizzle as readily as
   * a constructed vector - TSL types a built vec2 and `position.xz` quite
   * differently, and this is called with both.
   */
  // Typed off positionLocal.x rather than float(): TSL gives a constructed
  // float and a swizzled component different (and incompatible) types, and
  // this helper is called with a swizzle.
  type FloatNode = typeof positionLocal.x

  const toUv = (v: FloatNode) =>
    v.add(half).div(worldSize * SEA_SPAN).sub(0.5).mul(SEA_SPAN).add(0.5)

  const landinessAt = (x: FloatNode, z: FloatNode) =>
    clamp(uLand.sample(vec2(toUv(x), toUv(z))).r, float(0), float(1))

  // Shallow water: a band just seaward of the coastline.
  const shallowness = smoothstep(float(0.0), float(0.62), landiness)
  const base = mix(uDeep, uShallow, shallowness)

  // Foam: a narrow ring right at the waterline, with a slow breathing motion
  // so the shore is never completely still. Deliberately gentle - this is a
  // place to sit, not a storm.
  const swell = sin(motionTime.mul(0.6)).mul(0.012)
  const foamBand = smoothstep(float(0.40), float(0.56), landiness.add(swell))
    .mul(float(1).sub(smoothstep(float(0.60), float(0.74), landiness)))

  /**
   * Gerstner displacement.
   *
   * Each component moves a vertex *along* its direction as well as up, which is
   * what gives a wave its sharp crest and broad trough - a plain sum of sines
   * gives symmetric ripples that read as corrugated metal. Steepness is capped
   * well below the self-intersection limit, because this is a calm sea.
   *
   * Amplitude is damped to nothing over land, so the swell does not roll
   * through the beach.
   */
  const displaced = Fn(() => {
    const p = positionLocal
    const shore = float(1).sub(smoothstep(float(0.05), float(0.75), landinessAt(p.x, p.z)))

    const offset = vec3(0, 0, 0).toVar()
    for (const wave of WAVES) {
      const k = (Math.PI * 2) / wave.length
      const dir = normalize(vec2(wave.dx, wave.dz))
      const phase = dot(vec2(p.x, p.z), dir).mul(k).add(motionTime.mul(wave.speed * Math.sqrt(9.81 * k)))
      const amplitude = float(wave.amplitude).mul(shore)
      const lateral = amplitude.mul(wave.steepness)
      offset.addAssign(vec3(
        dir.x.mul(lateral).mul(cos(phase)),
        amplitude.mul(sin(phase)),
        dir.y.mul(lateral).mul(cos(phase)),
      ))
    }
    return offset
  })

  /**
   * Analytic normal, from the derivative of the same sum.
   *
   * Computing it rather than letting the geometry keep its flat up-vector is
   * the difference between a wavy plane and water: the lighting has to move
   * with the surface or the swell is invisible at any distance.
   */
  const waveNormal = Fn(() => {
    const p = positionLocal
    const shore = float(1).sub(smoothstep(float(0.05), float(0.75), landinessAt(p.x, p.z)))
    const slope = vec2(0, 0).toVar()
    for (const wave of WAVES) {
      const k = (Math.PI * 2) / wave.length
      const dir = normalize(vec2(wave.dx, wave.dz))
      const phase = dot(vec2(p.x, p.z), dir).mul(k).add(motionTime.mul(wave.speed * Math.sqrt(9.81 * k)))
      const d = float(wave.amplitude).mul(shore).mul(k).mul(cos(phase))
      slope.addAssign(vec2(dir.x.mul(d), dir.y.mul(d)))
    }
    return normalize(vec3(slope.x.negate(), 1, slope.y.negate()))
  })

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    opacity: 0.93,
    side: DoubleSide,
  })

  material.positionNode = positionLocal.add(displaced())
  material.normalNode = waveNormal()

  // A cheap specular-ish sheen from the wave normal, so crests catch the light
  // and the sea reads as a surface rather than as a coloured plane.
  const sheen = pow(max(dot(waveNormal(), normalize(vec3(0.3, 1, 0.2))), float(0)), float(28)).mul(0.5)

  material.colorNode = mix(base, uFoam, foamBand.mul(0.9)).mul(uLit).add(uFoam.mul(sheen).mul(uLit))

  const mesh = new Mesh(geometry, material)
  mesh.position.y = seaLevelY
  mesh.name = 'ocean'
  mesh.renderOrder = 1

  return {
    mesh,
    setLandField(field: Float32Array, size: number) {
      const next = makeLandTexture(field, size)
      landTexture.dispose()
      landTexture = next
      uLand.value = next
    },
    apply(state, water, deep, foam) {
      uShallow.value.copy(water)
      uDeep.value.copy(deep)
      uFoam.value.copy(foam)
      // The sea is lit by the same sky as everything else. Floor it well above
      // zero so midnight water still reads as water and not as a hole.
      uLit.value = 0.46 + state.daylight * 0.62
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      landTexture.dispose()
    },
  }
}

/**
 * Blur the land mask into a shore falloff.
 *
 * The raw heightfield has a hard land/water edge, which gives a one-pixel foam
 * line and no shallows at all. A few box-blur passes over the *mask* (not the
 * height) turn that edge into a gradient whose value is a usable proxy for
 * "how close to shore am I".
 */
function makeLandTexture(field: Float32Array, size: number): DataTexture {
  const mask = new Float32Array(size * size)
  for (let i = 0; i < field.length; i++) mask[i] = field[i] > 0.004 ? 1 : 0

  const scratch = new Float32Array(size * size)
  const radius = Math.max(2, Math.round(size / 18))
  for (let pass = 0; pass < 3; pass++) {
    blurAxis(mask, scratch, size, radius, true)
    blurAxis(scratch, mask, size, radius, false)
  }

  const tex = new DataTexture(mask, size, size, RedFormat, FloatType)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

function blurAxis(src: Float32Array, dst: Float32Array, size: number, radius: number, horizontal: boolean): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      let n = 0
      for (let k = -radius; k <= radius; k++) {
        const sx = horizontal ? x + k : x
        const sy = horizontal ? y : y + k
        if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue
        sum += src[sy * size + sx]
        n++
      }
      dst[y * size + x] = n > 0 ? sum / n : 0
    }
  }
}
