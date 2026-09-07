import {
  Mesh, InstancedBufferGeometry, InstancedInterleavedBuffer,
  InterleavedBufferAttribute, ConeGeometry, DynamicDrawUsage,
  DataTexture, RGBAFormat, FloatType, LinearFilter, ClampToEdgeWrapping,
  RepeatWrapping, Color, Sphere, Vector3,
} from 'three'
import { MeshToonNodeMaterial } from 'three/webgpu'
import {
  attribute, uniform, positionLocal, texture, vec2, vec3, float,
  cos, sin, mix, clamp, smoothstep, Fn, If, floor, fract,
} from 'three/tsl'
import { makeToonRamp, PROP_RAMP_STOPS } from './materials/toonRamp'
import { profileToTexture, type RadialProfile } from './terrain/profile'
import { FLOATS_PER_INSTANCE, type DirtyRange } from '@/island/bridge'
import { MEADOW_LEVEL, OVERDUE_FLOOR, STAGE } from '@/island/derive'
import { ELEVATION_HORIZON_DAYS, TERRAIN } from '@/core/config'
import { MS_PER_DAY } from '@/island/derive'

/**
 * The plants.
 *
 * Every task is one instance of one geometry, and the vertex shader works out
 * where it belongs. That is the important part: a plant's position is *not*
 * stored anywhere, on the CPU or the GPU. The instance carries its due date;
 * the shader turns "how long is left" into a normalised elevation, looks that
 * elevation up in the terrain profile to get a radius and a ground height, and
 * places the plant there for whatever `now` currently is.
 *
 * Downhill drift therefore costs nothing. A task due in a week descends over
 * that week because the clock moved, not because anything simulated it, and the
 * island cannot fall out of step with the workspace because it never held a
 * position to fall out of step with.
 */

export interface Plants {
  mesh: Mesh
  /** Grow or shrink the instance buffer. Returns the writable float view. */
  resize(count: number): Float32Array
  /** Mark ranges dirty so only those instances are uploaded. */
  markDirty(ranges: DirtyRange[]): void
  setProfile(profile: RadialProfile): void
  setNow(millis: number): void
  /** 0 at deep night, 1 at midday. Lanterns glow as it falls. */
  setDaylight(daylight: number): void
  setSeasonTint(tint: Color): void
  dispose(): void
}

/** Instances allocated up front, grown geometrically to avoid churn. */
const INITIAL_CAPACITY = 256

/** Species count, mirroring SPECIES_COUNT in derive.ts. */
const SPECIES_SPREAD = 6

const PLANT_RADIUS = 2.3
const PLANT_HEIGHT = 10

/** Shared with picking, so the CPU and the shader agree about where a plant is. */
export const PLANT_HALF_HEIGHT = PLANT_HEIGHT / 2
/** Click tolerance. Pixel-accurate picking at diorama zoom lands for nobody. */
export const PLANT_PICK_RADIUS = 3.4

export function createPlants(): Plants {
  // A cone is a stand-in for the Phase 8 species meshes. It is deliberately
  // cheap: the interesting work here is the placement, and a detailed model
  // would only make the instancing harder to read.
  //
  // Sized against the *camera*, not against realism. The isle is 220 m across
  // and the diorama sits 300 m out, so a botanically sensible 1.8 m sapling is
  // about two pixels tall and effectively invisible. Plants on this island are
  // map markers as much as scenery.
  const source = new ConeGeometry(PLANT_RADIUS, PLANT_HEIGHT, 6, 1)
  source.translate(0, PLANT_HEIGHT / 2, 0)

  const geometry = new InstancedBufferGeometry()
  geometry.index = source.index
  geometry.attributes.position = source.attributes.position
  geometry.attributes.normal = source.attributes.normal
  geometry.attributes.uv = source.attributes.uv

  let capacity = INITIAL_CAPACITY
  let data = new Float32Array(capacity * FLOATS_PER_INSTANCE)
  let interleaved = makeInterleaved(data)
  applyInstanceAttributes(geometry, interleaved)
  geometry.instanceCount = 0

  // The isle never leaves this sphere, and instance positions are computed in
  // the shader - so an automatic bounding volume would be wrong. Set it once,
  // generously, rather than letting frustum culling remove everything.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), TERRAIN.worldSize)

  let profileTexture = makeProfileTexture(null)

  const uNow = uniform(0)
  const uHorizon = uniform(ELEVATION_HORIZON_DAYS * MS_PER_DAY)
  const uProfile = texture(profileTexture)
  const uPeak = uniform(TERRAIN.peakHeight)
  const uTint = uniform(new Color(0xffffff))

  const aAngle = attribute<'float'>('iAngle', 'float')
  const aDue = attribute<'float'>('iDue', 'float')
  const aJitter = attribute<'float'>('iJitter', 'float')
  const aSpecies = attribute<'float'>('iSpecies', 'float')
  const aStage = attribute<'float'>('iStage', 'float')
  const aScale = attribute<'float'>('iScale', 'float')

  /**
   * Normalised elevation from the due date.
   *
   * Mirrors `elevationFor` in derive.ts exactly, including the shallows floor
   * and the meadow level for undated work. Two implementations of one rule is a
   * liability, but the alternative is a CPU round-trip per plant per frame -
   * so the CPU version is the reference and derive.test.ts pins the numbers.
   */
  const elevation = Fn(() => {
    const level = float(0).toVar()
    // -1 is the undated sentinel; anything at or below it is meadow.
    If(aDue.lessThan(float(0)), () => {
      level.assign(float(MEADOW_LEVEL))
    }).Else(() => {
      const remaining = aDue.sub(uNow)
      level.assign(clamp(remaining.div(uHorizon), float(OVERDUE_FLOOR), float(1)))
    })
    return level
  })

  const placed = Fn(() => {
    const level = elevation()

    // Sample the profile: x is elevation, y is angle. The lookup is what makes
    // this a single fetch rather than a search through the heightfield.
    const angleU = aAngle.div(Math.PI * 2).fract()
    const levelU = clamp(level, float(0), float(1))
    const sampled = uProfile.sample(vec2(levelU, angleU))

    const radius = sampled.x
    const groundHeight = sampled.y

    // Jitter within the wedge so a region reads as a stand of plants rather
    // than a row of them. Deterministic, from the instance's own jitter value.
    const wobbleAngle = aAngle.add(aJitter.sub(0.5).mul(0.16))
    const wobbleRadius = radius.mul(float(1).sub(aJitter.mul(0.10)))

    // Overdue work has drifted past the shore, so it sits below the waterline
    // and bobs. Section 3.3: retrieved, never lost.
    const submerged = clamp(level.negate().div(float(-OVERDUE_FLOOR)), float(0), float(1))
    const bob = sin(uNow.div(900).add(aJitter.mul(6.28))).mul(0.22).mul(submerged)
    const y = mix(groundHeight, float(-1.1), submerged).add(bob)

    return vec3(
      cos(wobbleAngle).mul(wobbleRadius),
      y,
      sin(wobbleAngle).mul(wobbleRadius),
    )
  })

  const material = new MeshToonNodeMaterial({
    gradientMap: makeToonRamp(PROP_RAMP_STOPS),
  })

  // Scale: bigger with the estimate, and growing through the stages so a seed
  // is visibly smaller than a lantern.
  const stageScale = mix(float(0.45), float(1.0), clamp(aStage.div(3), float(0), float(1)))

  material.positionNode = placed().add(positionLocal.mul(aScale).mul(stageScale))

  // Foliage colour varies by species, and a finished task becomes a lantern.
  //
  // Written as a plain expression rather than an If/Else over a `.toVar()`.
  // The branching version rendered every plant flat white, because `vec3()`
  // with no arguments is not a usable variable to assign into - and a shader
  // that silently produces white is indistinguishable from a material that
  // never received a colour node at all.
  const speciesHue = fract(floor(aSpecies).div(float(SPECIES_SPREAD)))
  const foliage = mix(vec3(0.30, 0.68, 0.31), vec3(0.76, 0.80, 0.34), speciesHue)
  const lantern = vec3(1.0, 0.80, 0.42)
  const lit = smoothstep(float(STAGE.bloom - 0.5), float(STAGE.lantern - 0.5), aStage)
  // A lantern is lit work, so it glows rather than merely being a warm colour.
  // MeshToonNodeMaterial has no emissive channel - toon shading is a lighting
  // model, not a PBR one - so the glow is folded into the base colour instead
  // and Phase 8 gives lanterns a real bloom pass.
  material.colorNode = mix(foliage, lantern.mul(1.35), lit).mul(uTint)

  /**
   * Lanterns are lit work, so they have to be *lit*: self-luminous, not merely
   * warm. Toon shading is a lighting model without an emissive channel, but
   * the node material still has an emissive slot that bypasses the lights, so
   * the lantern colour is added there - faint by day, full at night, where it
   * is also what the bloom pass catches. Without this the four completed tasks
   * on the hill were dark cream cones at 22:00, indistinguishable from seeds.
   */
  const uNight = uniform(0)
  // `emissiveNode` is read by NodeMaterial.setupLighting for every lit node
  // material at runtime; the toon material's *typings* simply omit it.
  ;(material as unknown as { emissiveNode: unknown }).emissiveNode =
    lantern.mul(lit).mul(uNight.mul(1.6).add(0.12))

  const mesh = new Mesh(geometry, material)
  mesh.name = 'plants'
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.frustumCulled = false

  function makeInterleaved(buffer: Float32Array): InstancedInterleavedBuffer {
    const b = new InstancedInterleavedBuffer(buffer, FLOATS_PER_INSTANCE, 1)
    b.setUsage(DynamicDrawUsage)
    return b
  }

  /**
   * Expose one interleaved buffer as seven named single-float attributes.
   *
   * Interleaved is the whole point of the bridge: a plant's fields all change
   * together, so keeping them adjacent means a change is one contiguous
   * range and one upload rather than seven scattered ones. Every attribute
   * below is a *view* onto the same backing store at a different offset.
   */
  function applyInstanceAttributes(g: InstancedBufferGeometry, b: InstancedInterleavedBuffer): void {
    INSTANCE_CHANNELS.forEach((name, offset) => {
      g.setAttribute(name, new InterleavedBufferAttribute(b, 1, offset))
    })
  }

  return {
    mesh,

    resize(count: number): Float32Array {
      if (count <= capacity) {
        geometry.instanceCount = count
        mesh.visible = count > 0
        return data
      }
      // Grow geometrically. Reallocating to exactly the new count means a
      // realloc on every single row someone adds.
      while (capacity < count) capacity *= 2
      data = new Float32Array(capacity * FLOATS_PER_INSTANCE)
      interleaved = makeInterleaved(data)
      applyInstanceAttributes(geometry, interleaved)
      geometry.instanceCount = count
      mesh.visible = count > 0
      return data
    },

    markDirty(ranges: DirtyRange[]): void {
      // One buffer, so one set of ranges - this is the payoff of interleaving.
      interleaved.clearUpdateRanges()
      for (const range of ranges) {
        interleaved.addUpdateRange(range.start * FLOATS_PER_INSTANCE, range.count * FLOATS_PER_INSTANCE)
      }
      interleaved.needsUpdate = ranges.length > 0
    },

    setProfile(profile: RadialProfile): void {
      const next = makeProfileTexture(profile)
      profileTexture.dispose()
      profileTexture = next
      uProfile.value = next
      uPeak.value = profile.peakHeight
    },

    setDaylight(daylight: number): void {
      // 1 at deep night, 0 at noon: the glow is the inverse of the sun.
      uNight.value = Math.max(0, Math.min(1, 1 - daylight))
    },

    setNow(millis: number): void {
      uNow.value = millis
    },

    setSeasonTint(tint: Color): void {
      uTint.value.copy(tint)
    },

    dispose(): void {
      geometry.dispose()
      source.dispose()
      material.dispose()
      profileTexture.dispose()
    },
  }
}

/** Channel order, matching the layout `writeRange` in the bridge produces. */
const INSTANCE_CHANNELS = ['iAngle', 'iDue', 'iJitter', 'iSpecies', 'iStage', 'iScale', 'iEntity'] as const

function makeProfileTexture(profile: RadialProfile | null): DataTexture {
  const packed = profile
    ? profileToTexture(profile)
    : { data: new Float32Array(4), width: 1, height: 1 }
  const tex = new DataTexture(packed.data, packed.width, packed.height, RGBAFormat, FloatType)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  // Elevation clamps at both ends; angle wraps, because the isle is a circle.
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = RepeatWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}
