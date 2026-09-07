import { PerspectiveCamera, Vector3, MathUtils } from 'three'
import { prefersReducedMotion } from '@/core/reducedMotion'

/**
 * The snow-globe camera.
 *
 * Phases 1 through 5 run entirely on this, which is deliberate: it means there
 * is a beautiful, demoable build long before the character controller exists,
 * and if the Keeper is ever late the diorama is a complete product on its own.
 * It stays as a toggle after the Keeper lands, because it is the best overview
 * of the whole island and the best screenshot.
 */
export interface DioramaOptions {
  minDistance: number
  maxDistance: number
  minPolar: number
  maxPolar: number
  /** Radians per second of idle rotation. Disabled under reduced motion. */
  driftSpeed: number
}

/** Below this viewport aspect the camera pulls back to keep the isle in frame. */
const FRAMING_ASPECT = 1.6

const DEFAULTS: DioramaOptions = {
  minDistance: 55,
  maxDistance: 460,
  minPolar: 0.18,
  maxPolar: 1.32,
  driftSpeed: 0.028,
}

export class DioramaCamera {
  readonly camera: PerspectiveCamera
  readonly target = new Vector3(0, 3, 0)

  private azimuth = Math.PI * 0.28
  private polar = 0.70
  private distance = 305

  private targetAzimuth = this.azimuth
  private targetPolar = this.polar
  private targetDistance = this.distance

  private dragging = false
  private lastX = 0
  private lastY = 0
  private idleSeconds = 0
  private readonly opts: DioramaOptions
  private readonly element: HTMLElement
  private disposed = false
  private aspectCompensation = 1

  constructor(element: HTMLElement, aspect: number, opts: Partial<DioramaOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    this.element = element
    this.camera = new PerspectiveCamera(38, aspect, 0.5, 1400)
    this.attach()
    this.apply(1)
  }

  private attach(): void {
    const el = this.element
    el.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const el = this.element
    el.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('wheel', this.onWheel)
    el.removeEventListener('keydown', this.onKeyDown)
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    this.dragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.idleSeconds = 0
    this.element.focus()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.targetAzimuth -= dx * 0.005
    this.targetPolar = MathUtils.clamp(this.targetPolar - dy * 0.004, this.opts.minPolar, this.opts.maxPolar)
    this.idleSeconds = 0
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const scale = Math.exp(e.deltaY * 0.0012)
    this.targetDistance = MathUtils.clamp(
      this.targetDistance * scale,
      this.opts.minDistance,
      this.opts.maxDistance,
    )
    this.idleSeconds = 0
  }

  /** Keyboard parity with the mouse. Nothing here may be pointer-only. */
  private onKeyDown = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 0.16 : 0.06
    switch (e.key) {
      case 'ArrowLeft': this.targetAzimuth += step; break
      case 'ArrowRight': this.targetAzimuth -= step; break
      case 'ArrowUp': this.targetPolar = MathUtils.clamp(this.targetPolar - step * 0.6, this.opts.minPolar, this.opts.maxPolar); break
      case 'ArrowDown': this.targetPolar = MathUtils.clamp(this.targetPolar + step * 0.6, this.opts.minPolar, this.opts.maxPolar); break
      case '+': case '=': this.targetDistance = MathUtils.clamp(this.targetDistance * 0.9, this.opts.minDistance, this.opts.maxDistance); break
      case '-': case '_': this.targetDistance = MathUtils.clamp(this.targetDistance * 1.1, this.opts.minDistance, this.opts.maxDistance); break
      default: return
    }
    e.preventDefault()
    this.idleSeconds = 0
  }

  update(dt: number): void {
    // Idle drift, so an untouched island still breathes. Reduced motion turns
    // this off entirely rather than merely slowing it.
    if (!this.dragging && !prefersReducedMotion()) {
      this.idleSeconds += dt
      if (this.idleSeconds > 3) {
        this.targetAzimuth += this.opts.driftSpeed * dt
      }
    }

    // Critically-damped-ish smoothing. Unhurried, because this is world motion
    // and not interface motion.
    const k = 1 - Math.exp(-dt * 7.5)
    this.azimuth += (this.targetAzimuth - this.azimuth) * k
    this.polar += (this.targetPolar - this.polar) * k
    this.distance += (this.targetDistance - this.distance) * k
    this.apply(k)
  }

  private apply(_k: number): void {
    const sinPolar = Math.sin(this.polar)
    const d = this.framedDistance
    this.camera.position.set(
      this.target.x + d * sinPolar * Math.sin(this.azimuth),
      this.target.y + d * Math.cos(this.polar),
      this.target.z + d * sinPolar * Math.cos(this.azimuth),
    )
    this.camera.lookAt(this.target)
  }

  /**
   * Keep the island framed at any viewport shape.
   *
   * A perspective camera's *vertical* fov is fixed, so a tall narrow window
   * crops horizontally - the diorama silently stops being a diorama and
   * becomes a close-up of a hillside. Widening the effective distance below an
   * aspect of 1.6 restores the whole-island read that the snow-globe view
   * exists to provide.
   */
  /**
   * Named framings.
   *
   * The home page wants the whole isle with sea around it and a little sky;
   * standing on the isle wants to be closer and lower. Both are the same
   * camera, retargeted - so the transition between them is the existing
   * smoothing rather than a cut, which is what Section 11 asks for.
   */
  setFraming(framing: 'home' | 'isle'): void {
    if (framing === 'home') {
      this.targetDistance = 305
      this.targetPolar = 0.70
    } else {
      this.targetDistance = 205
      this.targetPolar = 0.86
    }
    this.idleSeconds = 0
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
    this.aspectCompensation = aspect < FRAMING_ASPECT ? FRAMING_ASPECT / Math.max(0.35, aspect) : 1
  }

  /** Distance actually used, after aspect compensation. */
  private get framedDistance(): number {
    return this.distance * this.aspectCompensation
  }
}
