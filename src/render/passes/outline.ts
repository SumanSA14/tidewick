import type { Scene, Camera, Color, DirectionalLight } from 'three'
import { Vector3 } from 'three'
import { RenderPipeline } from 'three/webgpu'
import type { Renderer } from 'three/webgpu'
import {
  pass, mrt, output, normalView, screenUV, screenSize,
  Fn, vec2, vec3, vec4, float, uniform, dot, abs, clamp, step, mix,
  perspectiveDepthToViewZ, cameraNear, cameraFar,
} from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { godrays } from 'three/examples/jsm/tsl/display/GodraysNode.js'
import type GodraysNode from 'three/examples/jsm/tsl/display/GodraysNode.js'

/**
 * Screen-space depth-and-normal edge detection.
 *
 * The brief asks for both outline techniques, and they solve different
 * problems. Inverted-hull gives a crisp, artist-controllable width and is used
 * for the Keeper and props - but it only ever draws silhouettes, and it falls
 * apart on hard-normal geometry, which is precisely what terraced terrain is.
 * This pass catches the interior creases: every plateau edge, every cliff lip,
 * every crease where two terraces meet. On the terrain it is doing almost all
 * of the visible work.
 *
 * The depth term is divided by view-space distance before thresholding. That
 * is what holds the Phase 1 criterion of "outlines stay crisp at every zoom" -
 * an absolute depth threshold picks out near geometry and quietly loses every
 * edge in the highlands as the camera pulls back.
 */
export interface OutlineSettings {
  thickness: number
  normalStrength: number
  depthStrength: number
  threshold: number
  /** Initial bloom strength. Zero (the default) leaves the glow off. */
  bloom?: number
  /**
   * Initial god-rays strength. Zero (the default) builds no raymarch pass at
   * all - not a pass at strength zero, which would still march every frame.
   */
  godrays?: number
  /**
   * Render a view-normal target alongside colour and use it in the ink. On by
   * default; the low tiers turn it off, because the normal term is faint by
   * design and the extra full-resolution target is a measurable cost on an
   * integrated GPU (see `TierBudget.outlineNormals`).
   */
  normals?: boolean
}

/**
 * Tuned against terraced terrain, which breaks the textbook settings badly.
 *
 * Every plateau lip is a 90-degree normal discontinuity, so `1 - dot(n0, n1)`
 * saturates at 1.0 along each one. That alone is survivable on smooth terrain,
 * where a crease is a thin line. Here it is not: at diorama zoom a cliff face
 * is only two or three pixels tall, so a four-tap cross centred anywhere on it
 * finds the lip, and the *entire riser* fills with flat outline colour. The
 * island stops responding to light, and no amount of adjusting the palette or
 * the lamps makes any difference - which is exactly how this was eventually
 * found.
 *
 * So the normal term is turned down to almost nothing and the depth term
 * carries the pass. The separation is enormous once you look at the numbers:
 * against the sky the relative depth jump is on the order of 6, while a 2 m
 * terrace lip seen from 210 m away is about 0.02. A threshold anywhere between
 * them inks true silhouettes and leaves every interior crease alone - which is
 * what the reference art does too, separating terraces by colour (grass on
 * top, stone on the wall) rather than by line.
 */
export const DEFAULT_OUTLINE: OutlineSettings = {
  thickness: 1.0,
  normalStrength: 0.10,
  depthStrength: 0.35,
  threshold: 0.85,
}

export interface OutlinePost {
  pipeline: RenderPipeline
  setOutlineColor(color: Color): void
  setSettings(next: Partial<OutlineSettings>): void
  /**
   * Point the pass at a different camera.
   *
   * The Stage has two - the diorama and the Keeper's follow camera - and
   * rebuilding this whole pipeline on every toggle would recompile shaders
   * mid-interaction. `PassNode.camera` is a plain reference, and near/far reach
   * the shader as uniforms refreshed each frame, so reassigning it is enough.
   */
  setCamera(camera: Camera): void
  /** Bloom strength; zero is off. Tier-controlled. */
  setBloom(strength: number): void
  /** True when the tier built a god-rays pass. */
  readonly godraysEnabled: boolean
  /** God-rays strength; a no-op when the pass was not built. */
  setGodrays(strength: number): void
  /** The colour the rays carry - the sun's, as the daylight sets it. */
  setSunColor(r: number, g: number, b: number): void
  dispose(): void
}

/**
 * GodraysNode captures its camera at construction: the world matrix and the
 * inverse projection as uniforms, near and far as reference nodes. Nothing
 * public re-points them, so this reaches in. The alternatives - one god-rays
 * node per camera, or rebuilding the pipeline on every toggle - recompile
 * shaders mid-interaction, which is precisely what `setCamera` exists to avoid.
 */
function retargetGodrays(node: GodraysNode, camera: Camera): void {
  const privates = node as unknown as {
    _camera: Camera
    _cameraMatrixWorld: { value: unknown }
    _cameraProjectionMatrixInverse: { value: unknown }
    _cameraNear: { object: unknown }
    _cameraFar: { object: unknown }
  }
  privates._camera = camera
  privates._cameraMatrixWorld.value = camera.matrixWorld
  privates._cameraProjectionMatrixInverse.value = camera.projectionMatrixInverse
  privates._cameraNear.object = camera
  privates._cameraFar.object = camera
}

export function createOutlinePost(
  renderer: Renderer,
  scene: Scene,
  camera: Camera,
  outlineColor: Color,
  settings: OutlineSettings = DEFAULT_OUTLINE,
  /** The shadow-casting sun. Required for god-rays; ignored without them. */
  sun: DirectionalLight | null = null,
): OutlinePost {
  const scenePass = pass(scene, camera)
  const useNormals = settings.normals ?? true

  // With normals on, ask the scene pass for a view-space normal buffer
  // alongside colour - MRT, because a second full scene render with an
  // override material would double the draw calls for the entire island. With
  // them off the pass is a plain colour + depth render and the ink is
  // depth-only.
  if (useNormals) scenePass.setMRT(mrt({ output, normal: normalView }))

  const colorTex = scenePass.getTextureNode('output')
  const normalTex = useNormals ? scenePass.getTextureNode('normal') : null
  const depthTex = scenePass.getTextureNode('depth')

  const uThickness = uniform(settings.thickness)
  const uNormalStrength = uniform(settings.normalStrength)
  const uDepthStrength = uniform(settings.depthStrength)
  const uThreshold = uniform(settings.threshold)
  const uColor = uniform(vec3(outlineColor.r, outlineColor.g, outlineColor.b))

  const inked = Fn(() => {
    const texel = vec2(1.0).div(screenSize).mul(uThickness)

    const centerNormal = normalTex ? normalTex.sample(screenUV).xyz : null
    const centerViewZ = perspectiveDepthToViewZ(depthTex.sample(screenUV).r, cameraNear, cameraFar)

    // Four-tap cross. Cheaper than a full Sobel and, on hard-normal geometry,
    // visually indistinguishable from it.
    const tap = (offset: ReturnType<typeof vec2>) => {
      const uvN = screenUV.add(offset)
      const z = perspectiveDepthToViewZ(depthTex.sample(uvN).r, cameraNear, cameraFar)
      return {
        normal: normalTex && centerNormal
          ? float(1.0).sub(clamp(dot(centerNormal, normalTex.sample(uvN).xyz), 0.0, 1.0))
          : float(0.0),
        depth: abs(centerViewZ.sub(z)),
      }
    }

    const left = tap(vec2(texel.x.negate(), 0))
    const right = tap(vec2(texel.x, 0))
    const down = tap(vec2(0, texel.y.negate()))
    const up = tap(vec2(0, texel.y))

    const normalDelta = left.normal.add(right.normal).add(down.normal).add(up.normal)
    const depthDelta = left.depth.add(right.depth).add(down.depth).add(up.depth)

    // Scale-invariant depth term: relative, not absolute, so a cliff edge inks
    // the same whether it fills the screen or sits on the horizon.
    const relativeDepth = depthDelta.div(abs(centerViewZ).add(0.001))

    const edge = step(
      uThreshold,
      normalDelta.mul(uNormalStrength).add(relativeDepth.mul(uDepthStrength)),
    )

    const sceneColor = colorTex.sample(screenUV)
    return mix(sceneColor.rgb, uColor, edge)
  })

  /**
   * Bloom, after the ink.
   *
   * Lanterns are the reward of the whole loop and MeshToonNodeMaterial has no
   * emissive channel, so their glow has to come from a post pass: bright warm
   * pixels bleed softly into their surroundings. The threshold sits high enough
   * that a sunlit beach does not bloom - only the lanterns and the sun disc
   * are meant to.
   *
   * Strength is a uniform so a quality tier can turn it down to nothing; at
   * zero the multiply produces black and the blur still runs, which is why the
   * Stage also skips this pipeline entirely on the Low tier.
   */
  const inkedColor = inked()
  const uBloom = uniform(settings.bloom ?? 0)
  // Zero builds no bloom at all. The mip chain runs whether or not its result
  // is multiplied by zero afterwards, and on Intel Iris Xe at 1080p that chain
  // is a measurable share of the frame (see the Phase 8 ablation in PLAN.md).
  let lit = inkedColor
  if ((settings.bloom ?? 0) > 0) {
    // Threshold above the brightest sunlit sand. At 0.78 the whole beach wore
    // a halo; lanterns and the sun disc are the only things meant to glow.
    const glow = bloom(vec4(inkedColor, 1), 1, 0.35, 0.88)
    lit = inkedColor.add(glow.rgb.mul(uBloom))
  }

  /**
   * God-rays. Built only when a tier asks; no tier does (see
   * `TierBudget.godrays` for what they looked like and why).
   *
   * A screen-space raymarch through the sun's shadow map at half resolution:
   * every pixel walks toward the camera counting how much of the way was in
   * light, so the low sun streams between the terraces and the trees. The node
   * returns that count as a grey density (its alpha is depth, for a blend this
   * pass does not use); it is coloured with the sun and added after the ink so
   * the outlines stay crisp underneath the haze. Forty steps rather than the
   * default sixty: at half resolution with the built-in gradient noise the
   * difference is invisible at diorama zoom, and this is the most expensive
   * pass on the isle.
   */
  const uRays = uniform(settings.godrays ?? 0)
  const uRayColor = uniform(new Vector3(1, 0.93, 0.8))
  let rays: GodraysNode | null = null
  if (sun && (settings.godrays ?? 0) > 0) {
    rays = godrays(depthTex, camera, sun)
    rays.raymarchSteps.value = 40
    rays.density.value = 0.55
    rays.maxDensity.value = 0.45
    rays.distanceAttenuation.value = 2
    lit = lit.add(rays.rgb.mul(uRayColor).mul(uRays))
  }

  const pipeline = new RenderPipeline(renderer)
  pipeline.outputNode = vec4(lit, 1)

  return {
    pipeline,
    setOutlineColor(color: Color) {
      uColor.value.set(color.r, color.g, color.b)
    },
    setSettings(next: Partial<OutlineSettings>) {
      if (next.thickness !== undefined) uThickness.value = next.thickness
      if (next.normalStrength !== undefined) uNormalStrength.value = next.normalStrength
      if (next.depthStrength !== undefined) uDepthStrength.value = next.depthStrength
      if (next.threshold !== undefined) uThreshold.value = next.threshold
    },
    setCamera(camera: Camera) {
      scenePass.camera = camera
      if (rays) retargetGodrays(rays, camera)
    },
    setBloom(strength: number) {
      uBloom.value = Math.max(0, strength)
    },
    godraysEnabled: rays !== null,
    setGodrays(strength: number) {
      uRays.value = Math.max(0, strength)
    },
    setSunColor(r: number, g: number, b: number) {
      uRayColor.value.set(r, g, b)
    },
    dispose() {
      rays?.dispose()
      pipeline.dispose()
    },
  }
}
