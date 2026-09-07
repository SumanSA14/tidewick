import { PerspectiveCamera, Vector3, MathUtils } from 'three'
import type { GroundSampler } from '@/keeper/controller'
import { prefersReducedMotion } from '@/core/reducedMotion'

/**
 * The third-person follow camera.
 *
 * A spring arm: the camera wants to sit `distance` behind the Keeper at
 * `polar` above them, and is pulled in whenever terrain would come between the
 * two. The Phase 6 gate is "camera never clips terrain", and on a terraced
 * island that is a real problem - the Keeper spends most of the game with a
 * cliff directly behind them.
 *
 * Occlusion is resolved by marching the arm rather than raycasting the terrain
 * mesh. The heightfield already answers "how high is the ground here" in one
 * lookup, so a raycast against 100k triangles to learn the same thing would be
 * slower and no more correct.
 */
export interface FollowOptions {
  distance: number
  minDistance: number
  /** Height above the Keeper's feet that the camera looks at - the chest. */
  eyeHeight: number
  /** Radians above the horizon. */
  polar: number
  minPolar: number
  maxPolar: number
  /** How fast the camera catches up. Higher is tighter, and less cosy. */
  stiffness: number
  /** Radians per pixel of pointer movement. */
  sensitivity: number
}

const DEFAULTS: FollowOptions = {
  distance: 22,
  minDistance: 5,
  // The Keeper's chest, not their feet: framing on the feet puts the character
  // in the lower third and most of the screen on the ground in front of them.
  eyeHeight: 4.4,
  // Lower than the first cut: at 0.42 the default view looked down at the
  // Keeper's back with the horizon as a sliver, and the sky - stars, clouds,
  // the sun - was never in frame unless the player dragged for it.
  polar: 0.30,
  minPolar: -0.15,
  maxPolar: 1.15,
  stiffness: 7,
  sensitivity: 0.0042,
}

/** Clearance kept between the camera and the ground it would otherwise enter. */
const GROUND_CLEARANCE = 1.4

/** Steps taken along the arm when looking for the first obstruction. */
const ARM_SAMPLES = 12

export class FollowCamera {
  readonly camera: PerspectiveCamera
  /** Yaw the controller reads, so movement is relative to what you can see. */
  yaw = Math.PI

  private polar: number
  private distance: number
  /** Where the arm actually is after occlusion, chased separately so that
   *  recovering from a pull-in eases out instead of snapping. */
  private armLength: number
  private readonly opts: FollowOptions
  private readonly element: HTMLElement
  private readonly focus = new Vector3()
  private readonly desired = new Vector3()
  private readonly position = new Vector3()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private pointerLocked = false
  private started = false
  private disposed = false

  constructor(element: HTMLElement, aspect: number, opts: Partial<FollowOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    this.element = element
    this.polar = this.opts.polar
    this.distance = this.opts.distance
    this.armLength = this.opts.distance
    this.camera = new PerspectiveCamera(52, aspect, 0.3, 1400)
    this.attach()
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /** Face the camera away from a world direction, used when handing over from
   *  the diorama so the transition does not spin. */
  faceFrom(x: number, z: number): void {
    this.yaw = Math.atan2(x, z)
  }

  /**
   * Advance one frame.
   *
   * `dt` is real frame time, not the fixed simulation step: the camera is
   * presentation, and coupling it to the 60 Hz sim would make it stutter on a
   * 144 Hz display.
   */
  update(
    targetX: number,
    targetY: number,
    targetZ: number,
    sampler: GroundSampler | null,
    dt: number,
  ): void {
    this.focus.set(targetX, targetY + this.opts.eyeHeight, targetZ)

    const sinPolar = Math.sin(this.polar)
    const cosPolar = Math.cos(this.polar)
    // Unit vector from the focus out to where the camera wants to be.
    const dirX = Math.sin(this.yaw) * cosPolar
    const dirY = sinPolar
    const dirZ = Math.cos(this.yaw) * cosPolar

    const allowed = sampler
      ? this.firstObstruction(dirX, dirY, dirZ, sampler)
      : this.distance

    // Pull in immediately, ease back out. Snapping outward would show the
    // player the inside of a cliff for a frame, which is the thing the whole
    // pull-in exists to prevent.
    if (allowed < this.armLength) this.armLength = allowed
    else this.armLength = MathUtils.damp(this.armLength, allowed, 3, dt)

    this.desired.set(
      this.focus.x + dirX * this.armLength,
      this.focus.y + dirY * this.armLength,
      this.focus.z + dirZ * this.armLength,
    )

    // Never below the ground under the camera itself, which the arm march can
    // still miss when the Keeper is standing at the very lip of a terrace.
    if (sampler) {
      const floor = sampler.heightAt(this.desired.x, this.desired.z) + GROUND_CLEARANCE
      if (this.desired.y < floor) this.desired.y = floor
    }

    if (!this.started) {
      // First frame: be where you belong rather than flying in from the origin.
      this.position.copy(this.desired)
      this.started = true
    } else {
      const lambda = prefersReducedMotion() ? 40 : this.opts.stiffness
      this.position.x = MathUtils.damp(this.position.x, this.desired.x, lambda, dt)
      this.position.y = MathUtils.damp(this.position.y, this.desired.y, lambda, dt)
      this.position.z = MathUtils.damp(this.position.z, this.desired.z, lambda, dt)
    }

    this.camera.position.copy(this.position)
    this.camera.lookAt(this.focus)
  }

  /**
   * How far along the arm the camera can sit before terrain gets in the way.
   *
   * Marches outward from the focus and stops at the first sample that would be
   * underground. Marching from the inside out matters: the first hit going
   * outward is the near wall, which is the one that would occlude.
   */
  private firstObstruction(
    dirX: number,
    dirY: number,
    dirZ: number,
    sampler: GroundSampler,
  ): number {
    for (let i = 1; i <= ARM_SAMPLES; i++) {
      const t = (i / ARM_SAMPLES) * this.distance
      const px = this.focus.x + dirX * t
      const py = this.focus.y + dirY * t
      const pz = this.focus.z + dirZ * t
      if (py - GROUND_CLEARANCE < sampler.heightAt(px, pz)) {
        // Back off to the previous clean sample.
        const previous = ((i - 1) / ARM_SAMPLES) * this.distance
        return Math.max(this.opts.minDistance, previous)
      }
    }
    return this.distance
  }

  /** Orbit by a pointer delta in pixels. */
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * this.opts.sensitivity
    this.polar = MathUtils.clamp(
      this.polar + dy * this.opts.sensitivity,
      this.opts.minPolar,
      this.opts.maxPolar,
    )
  }

  zoom(delta: number): void {
    this.distance = MathUtils.clamp(this.distance + delta, this.opts.minDistance + 3, 60)
  }

  private attach(): void {
    this.element.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 2) return
    this.dragging = true
    this.lastX = event.clientX
    this.lastY = event.clientY
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointerLocked) {
      this.orbit(event.movementX, event.movementY)
      return
    }
    if (!this.dragging) return
    this.orbit(event.clientX - this.lastX, event.clientY - this.lastY)
    this.lastX = event.clientX
    this.lastY = event.clientY
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.zoom(event.deltaY * 0.02)
  }

  private onLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }
}
