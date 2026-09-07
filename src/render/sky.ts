import {
  Mesh, SphereGeometry, BackSide, Color, Vector3, DataTexture, RGBAFormat,
  LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  positionLocal, normalize, mix, pow, max, dot, uniform, float, vec2, vec3,
  smoothstep, hash, floor, texture, atan, asin, clamp, Fn,
} from 'three/tsl'
import { motionTime } from './motion'
import { Perlin2D } from '@/core/rng'
import type { DaylightState } from '@/core/daylight'

/**
 * The sky dome.
 *
 * Geometry rather than a background clear, for a reason that is easy to miss:
 * the outline pass reads a normal buffer, and a cleared background never writes
 * one. Leave the sky as a clear and the horizon inks with whatever happened to
 * be in that attachment.
 *
 * Three layers over the gradient, each a function of the same daylight state
 * so none of them can disagree about the hour:
 *
 * - **Stars**, hashed from the view direction and faded in as the sun goes
 *   down. Sparse, and they twinkle only a little - a sky that sparkles is a
 *   screensaver.
 * - **A sun disc**, a soft edge on the forward-scatter term, so dawn and dusk
 *   have a sun in them rather than just a warm smear.
 * - **Clouds**, a small fbm texture generated once on the CPU and scrolled
 *   slowly across the dome. Generated rather than shipped because there is no
 *   art pipeline, and CPU rather than in the shader because six octaves of
 *   noise per sky pixel is a poor trade for a backdrop.
 */
export interface Sky {
  mesh: Mesh
  apply(state: DaylightState): void
  /** 0..1 cloud cover. Weather is cosmetic (Section 3.5), so this is the knob. */
  setCloudCover(cover: number): void
  dispose(): void
}

const CLOUD_TEXTURE_WIDTH = 512
const CLOUD_TEXTURE_HEIGHT = 128

export function createSky(radius = 900): Sky {
  const geometry = new SphereGeometry(radius, 48, 32)

  const uTop = uniform(new Color(0x4aa8e0))
  const uHorizon = uniform(new Color(0xd6f0f7))
  const uGlow = uniform(new Color(0xffe6c0))
  const uGlowPower = uniform(12)
  const uSunDir = uniform(new Vector3(0, 1, 0))
  const uSunColor = uniform(new Color(0xfff2d8))
  /** 0 at deep night, 1 at midday. */
  const uDaylight = uniform(1)
  const uCloudCover = uniform(0.42)

  const clouds = makeCloudTexture()
  const uClouds = texture(clouds)

  const direction = normalize(positionLocal)

  // Vertical gradient. The 0.65 exponent pushes the horizon colour further up
  // the dome than a linear blend does, which is how real haze behaves and what
  // keeps the sky from looking like a two-stop CSS gradient.
  const up = direction.y.mul(0.5).add(0.5)
  const base = mix(uHorizon, uTop, pow(up, float(0.65)))

  // Forward scatter around the sun. Cheap, and it is most of what sells dawn
  // and dusk - without it the sky changes colour but the sun is nowhere.
  const towardSun = max(dot(direction, uSunDir), float(0))
  const scatter = pow(towardSun, uGlowPower)

  // The disc itself: a soft-edged step very close to the sun direction. It is
  // only visible when the sun is up, and it dims as it lowers so dusk is a red
  // coin rather than a white hole.
  const disc = smoothstep(float(0.9982), float(0.9992), towardSun)
    .mul(uDaylight.mul(0.7).add(0.3))

  /**
   * Stars. The direction is quantised to a grid of cells and each cell rolls
   * once; a very high threshold leaves a few hundred stars across the dome.
   * A second hash sets the brightness, a slow sine makes them breathe. Only
   * above the horizon and only at night, both smoothly.
   */
  const stars = Fn(() => {
    const cell = floor(direction.mul(220))
    const seed = cell.x.mul(7.13).add(cell.y.mul(31.7)).add(cell.z.mul(113.1))
    const roll = hash(seed)
    const isStar = smoothstep(float(0.9965), float(0.9985), roll)
    const brightness = hash(seed.add(19.3)).mul(0.6).add(0.4)
    const twinkle = motionTime.mul(0.9).add(hash(seed.add(3.7)).mul(6.28)).sin().mul(0.12).add(0.88)
    const aboveHorizon = smoothstep(float(0.02), float(0.18), direction.y)
    const night = float(1).sub(smoothstep(float(0.08), float(0.45), uDaylight))
    return isStar.mul(brightness).mul(twinkle).mul(aboveHorizon).mul(night)
  })

  /**
   * Clouds, from an equirectangular texture. The dome is a sphere so the
   * lookup is (azimuth, elevation); the texture scrolls slowly in azimuth and
   * the band is confined to a slab above the horizon, so no cloud ever sits on
   * the sea. Lit by the sky itself: a cloud's colour is the horizon colour
   * pushed toward white, and toward the glow colour where it faces the sun.
   */
  const cloudLayer = Fn(() => {
    const azimuth = atan(direction.z, direction.x).div(6.2831853).add(0.5)
    const elevation = asin(clamp(direction.y, float(-1), float(1))).div(1.5707963)
    // Scroll: a full rotation in a little over an hour. Slow enough that you
    // never see it move, fast enough that it is never the same twice.
    const uvC = vec2(azimuth.add(motionTime.mul(0.00028)), elevation.mul(1.6).sub(0.05))
    const density = uClouds.sample(uvC).r
    const cover = smoothstep(float(1).sub(uCloudCover).sub(0.12), float(1).sub(uCloudCover).add(0.28), density)
    // Fade out at the horizon and overhead, keeping a band.
    const band = smoothstep(float(0.03), float(0.16), direction.y).mul(float(1).sub(smoothstep(float(0.55), float(0.85), direction.y)))
    return cover.mul(band)
  })

  const cloudAmount = cloudLayer()
  // Cloud colour: bright by day, dim at night, warm toward the sun.
  const cloudLit = mix(uHorizon.mul(0.55), vec3(1, 1, 1), uDaylight.mul(0.85))
  const cloudColor = mix(cloudLit, uGlow, scatter.mul(0.6)).mul(uDaylight.mul(0.8).add(0.2))

  const skyColor = base
    .add(uGlow.mul(scatter))
    .add(uSunColor.mul(disc).mul(2.2))
    .add(vec3(1, 1, 1).mul(stars()))

  const material = new MeshBasicNodeMaterial({ side: BackSide, fog: false })
  material.colorNode = mix(skyColor, cloudColor, cloudAmount.mul(0.92))
  material.toneMapped = false

  const mesh = new Mesh(geometry, material)
  mesh.name = 'sky'
  mesh.renderOrder = -1
  mesh.frustumCulled = false

  return {
    mesh,
    apply(state: DaylightState) {
      uTop.value.setRGB(state.skyTop.r, state.skyTop.g, state.skyTop.b)
      uHorizon.value.setRGB(state.skyHorizon.r, state.skyHorizon.g, state.skyHorizon.b)
      uGlow.value.setRGB(state.glow.r, state.glow.g, state.glow.b)
      uGlowPower.value = state.glowPower
      uSunDir.value.set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
      uSunColor.value.setRGB(state.sun.r, state.sun.g, state.sun.b)
      uDaylight.value = state.daylight
    },
    setCloudCover(cover: number) {
      uCloudCover.value = Math.max(0, Math.min(1, cover))
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      clouds.dispose()
    },
  }
}

/**
 * A tileable cloud field: fractal noise, thresholded softly, wrapped in X so
 * the scroll has no seam. A few hundred kilobytes, generated in a few
 * milliseconds, and it never changes - the *scroll* is the animation.
 */
function makeCloudTexture(): DataTexture {
  const w = CLOUD_TEXTURE_WIDTH
  const h = CLOUD_TEXTURE_HEIGHT
  const noise = new Perlin2D(0x7c10)
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sample on a cylinder so the left and right edges meet exactly.
      const a = (x / w) * Math.PI * 2
      const cx = Math.cos(a) * 2.2
      const cz = Math.sin(a) * 2.2
      const v = y / h
      const n = noise.fbm(cx + v * 1.7, cz - v * 1.1, 5, 2.1, 0.52) * 0.5 + 0.5
      // Puffy: bias the field so most of it is clear and the rest is soft.
      const d = Math.max(0, Math.min(1, (n - 0.42) * 2.1))
      const at = (y * w + x) * 4
      const byte = Math.round(d * 255)
      data[at] = byte
      data[at + 1] = byte
      data[at + 2] = byte
      data[at + 3] = 255
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.wrapS = RepeatWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}
