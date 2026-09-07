import {
  InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute,
  BufferGeometry, BufferAttribute, Mesh, Sphere, Vector3, DoubleSide, Color,
} from 'three'
import { MeshToonNodeMaterial } from 'three/webgpu'
import {
  attribute, uniform, positionLocal, uv, sin, vec3, mix, Fn,
} from 'three/tsl'
import { motionTime } from './motion'
import { makeToonRamp, TERRAIN_RAMP_STOPS } from './materials/toonRamp'
import { mulberry32 } from '@/core/rng'
import { TERRAIN } from '@/core/config'
import type { TerracedField } from './terrain/terrace'

/**
 * Grass.
 *
 * Section 9 asks for a million instanced blades with GPU wind and compute
 * culling. The wind is here; the culling is not, and honestly so: WebGL2 has no
 * compute shaders, and this machine has no WebGPU adapter to run one on. So the
 * blades are culled the cheap way - by not existing where the camera cannot
 * see them matter (the sea, the beach) - and the count is a quality-tier
 * budget rather than a fixed number.
 *
 * **One triangle per blade.** A crossed pair reads better edge-on but costs
 * several times as much, and at 250k blades the triangle count is the frame
 * budget. Each blade gets a random yaw instead, so from any angle a good
 * fraction face the camera and the field never thins out into a set of lines.
 *
 * Everything per-blade lives in one interleaved buffer written once when the
 * terrain lands. Grass does not change with the workspace - it is scenery -
 * so there is no per-frame upload at all; the wind is entirely in the vertex
 * shader.
 */

export interface Grass {
  mesh: Mesh
  /** Rebuild for a new island. `count` is the tier budget. */
  populate(field: TerracedField, count: number, seed: number): void
  /** Blades actually placed by the last populate; what the HUD reports. */
  readonly count: number
  /** Tint toward the season's foliage, and dim with the daylight. */
  setLight(lit: number): void
  setWind(x: number, z: number, strength: number): void
  dispose(): void
}

/** x, y, z, phase, scale, yaw, r, g, b */
const FLOATS = 9

/** Blade height in world units, before per-blade scale. */
const BLADE_HEIGHT = 1.9
const BLADE_WIDTH = 0.28

/**
 * Which bands grow grass. Band zero is the beach, and the very top is stone -
 * the palette agrees, so blades stop where the moss does.
 */
const LOWEST_GRASS_BAND = 1
const HIGHEST_GRASS_FRACTION = 0.93

export function createGrass(): Grass {
  // One triangle per blade. The first cut was a tapered quad with a tip -
  // five vertices, three triangles - and at 250k blades that was 750k of the
  // 848k triangles in the frame, for a median of 33 ms. A blade of grass *is*
  // a tall triangle; from the diorama the two are indistinguishable, and this
  // is a third of the cost.
  const source = new BufferGeometry()
  const w = BLADE_WIDTH / 2
  source.setAttribute('position', new BufferAttribute(new Float32Array([
    -w, 0, 0,
    w, 0, 0,
    0, BLADE_HEIGHT, 0,
  ]), 3))
  source.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0.5, 1,
  ]), 2))
  source.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0.3, 1, 0, 0.3, 1, 0, 0.3, 1,
  ]), 3))
  source.setIndex([0, 1, 2])

  const geometry = new InstancedBufferGeometry()
  geometry.index = source.index
  geometry.attributes.position = source.attributes.position
  geometry.attributes.uv = source.attributes.uv
  geometry.attributes.normal = source.attributes.normal
  geometry.instanceCount = 0
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), TERRAIN.worldSize)

  let interleaved: InstancedInterleavedBuffer | null = null

  const uWind = uniform(new Vector3(0.7, 0, 0.4))
  const uLit = uniform(1)
  const uTint = uniform(new Color(0xffffff))

  const aOffset = attribute<'vec3'>('gOffset', 'vec3')
  const aPhase = attribute<'float'>('gPhase', 'float')
  const aScale = attribute<'float'>('gScale', 'float')
  const aYaw = attribute<'float'>('gYaw', 'float')
  const aColor = attribute<'vec3'>('gColor', 'vec3')

  /**
   * Place and sway.
   *
   * The bend is quadratic in height, so the root stays planted and the tip
   * moves - a blade rotating rigidly about its base reads as a metronome, not
   * as grass. Two frequencies, so no two blades are ever quite in step.
   */
  const placed = Fn(() => {
    const p = positionLocal
    const height = uv().y
    const bend = height.mul(height)

    const gust = sin(motionTime.mul(1.25).add(aPhase).add(aOffset.x.mul(0.06)).add(aOffset.z.mul(0.04))).mul(0.55)
    const flutter = sin(motionTime.mul(2.7).add(aPhase.mul(1.9))).mul(0.14)
    const sway = gust.add(flutter).mul(uWind.z).mul(bend).mul(aScale)

    // Rotate the blade about Y by its own yaw, then scale.
    const c = aYaw.cos()
    const s = aYaw.sin()
    const x = p.x.mul(c).sub(p.z.mul(s)).mul(aScale)
    const z = p.x.mul(s).add(p.z.mul(c)).mul(aScale)
    const y = p.y.mul(aScale)

    return vec3(
      aOffset.x.add(x).add(sway.mul(uWind.x)),
      aOffset.y.add(y),
      aOffset.z.add(z).add(sway.mul(uWind.y)),
    )
  })

  const material = new MeshToonNodeMaterial({
    gradientMap: makeToonRamp(TERRAIN_RAMP_STOPS),
    side: DoubleSide,
  })
  material.positionNode = placed()
  // Darker at the root, so the field has depth instead of reading as a flat
  // green plane with texture on it.
  material.colorNode = mix(aColor.mul(0.62), aColor, uv().y).mul(uTint).mul(uLit)

  const mesh = new Mesh(geometry, material)
  mesh.name = 'grass'
  // Grass receives the terrain's shadow but casts none: a shadow pass over a
  // million blades is the single most expensive thing this scene could do.
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  // Hidden until populated. The instance attributes only exist after the first
  // populate, and the WebGPU backend compiles the material on the first frame
  // the mesh is drawn - an empty draw before that compiles a shader with five
  // missing attributes and a warning for each.
  mesh.visible = false

  return {
    mesh,
    get count() { return geometry.instanceCount },

    populate(field, count, seed) {
      const data = new Float32Array(count * FLOATS)
      const rand = mulberry32(seed ^ 0x5bd1e995)
      const { bands, land, size, bandCount, worldSize, peakHeight } = field
      const half = worldSize / 2
      const cell = worldSize / size
      const bandHeight = peakHeight / Math.max(1, bandCount - 1)
      const highest = Math.floor((bandCount - 1) * HIGHEST_GRASS_FRACTION)

      // Collect the cells that grow grass once, then sample them uniformly.
      // Rejection sampling over the whole grid would spend most of its draws
      // on the sea.
      const eligible: number[] = []
      for (let i = 0; i < bands.length; i++) {
        if (land[i] && bands[i] >= LOWEST_GRASS_BAND && bands[i] <= highest) eligible.push(i)
      }

      let written = 0
      if (eligible.length > 0) {
        const rgb: [number, number, number] = [0, 0, 0]
        for (let n = 0; n < count; n++) {
          const i = eligible[Math.floor(rand() * eligible.length)]
          const gx = i % size
          const gz = Math.floor(i / size)
          // Keep blades off the very lip of a terrace, where they would float
          // over the riser below.
          const inset = 0.08
          const fx = inset + rand() * (1 - inset * 2)
          const fz = inset + rand() * (1 - inset * 2)
          const band = bands[i]

          grassColour(band / Math.max(1, bandCount - 1), rand(), rgb)

          const at = written * FLOATS
          data[at] = (gx + fx) * cell - half
          data[at + 1] = band * bandHeight
          data[at + 2] = (gz + fz) * cell - half
          data[at + 3] = rand() * Math.PI * 2
          data[at + 4] = 0.7 + rand() * 0.6
          data[at + 5] = rand() * Math.PI
          data[at + 6] = rgb[0]
          data[at + 7] = rgb[1]
          data[at + 8] = rgb[2]
          written++
        }
      }

      // The old buffer is released with its attributes when they are replaced
      // below; a GPU buffer has no explicit dispose at this level.
      interleaved = new InstancedInterleavedBuffer(data, FLOATS)
      geometry.setAttribute('gOffset', new InterleavedBufferAttribute(interleaved, 3, 0))
      geometry.setAttribute('gPhase', new InterleavedBufferAttribute(interleaved, 1, 3))
      geometry.setAttribute('gScale', new InterleavedBufferAttribute(interleaved, 1, 4))
      geometry.setAttribute('gYaw', new InterleavedBufferAttribute(interleaved, 1, 5))
      geometry.setAttribute('gColor', new InterleavedBufferAttribute(interleaved, 3, 6))
      geometry.instanceCount = written
      mesh.visible = written > 0
    },

    setLight(lit) {
      uLit.value = lit
    },

    setWind(x, z, strength) {
      const length = Math.hypot(x, z) || 1
      uWind.value.set(x / length, z / length, strength)
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/**
 * Blade colour by height, in linear RGB.
 *
 * Follows the terrain palette's shape - bright by the shore, deeper inland,
 * mossy toward the top - but a touch more saturated than the ground it stands
 * on, so blades separate from the terrace instead of vanishing into it. A
 * little per-blade variation keeps a field from reading as one flat swatch.
 */
function grassColour(t: number, jitter: number, out: [number, number, number]): void {
  let r: number
  let g: number
  let b: number
  if (t < 0.32) {
    const k = t / 0.32
    r = 0.36 - k * 0.08; g = 0.72 - k * 0.06; b = 0.22
  } else if (t < 0.80) {
    const k = (t - 0.32) / 0.48
    r = 0.28 - k * 0.06; g = 0.62 - k * 0.12; b = 0.20 + k * 0.03
  } else {
    const k = (t - 0.80) / 0.2
    r = 0.24 + k * 0.10; g = 0.50 - k * 0.06; b = 0.23 + k * 0.08
  }
  const v = 0.88 + jitter * 0.24
  out[0] = srgbToLinear(r * v)
  out[1] = srgbToLinear(g * v)
  out[2] = srgbToLinear(b * v)
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
