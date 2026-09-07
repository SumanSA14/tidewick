import { MAX_FRAME_MS, SIM_STEP_MS } from './config'

export interface LoopHandlers {
  /** Advances the simulation by exactly one fixed step. Called 0..n times per frame. */
  fixedUpdate(stepSeconds: number): void
  /**
   * Draws one frame. `alpha` is the interpolation factor in [0,1) between the
   * previous and current simulation states, so rendering stays smooth even
   * when the display refresh and the 60 Hz sim disagree (120 Hz panels, or a
   * frame that took 30 ms).
   */
  render(alpha: number, frameSeconds: number): void
}

export interface FrameTiming {
  /** Wall-clock milliseconds between this frame and the previous one. */
  frameMs: number
  /** Milliseconds spent inside our own update + render calls. */
  cpuMs: number
  /** Fixed-update steps executed this frame. */
  steps: number
}

/**
 * Fixed-timestep loop with interpolated rendering.
 *
 * The simulation must be deterministic and frame-rate independent, because the
 * island's downhill drift is a physical slide over real days. Tying it to
 * display refresh would make the same task arrive at the waterline at a
 * different time on a 60 Hz laptop than on a 144 Hz monitor.
 */
export class FixedLoop {
  private rafId = 0
  private lastTime = 0
  private accumulator = 0
  private running = false
  private readonly handlers: LoopHandlers

  onTiming: ((t: FrameTiming) => void) | null = null

  constructor(handlers: LoopHandlers) {
    this.handlers = handlers
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.accumulator = 0
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  get isRunning(): boolean {
    return this.running
  }

  private tick = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    let frameMs = now - this.lastTime
    this.lastTime = now

    // Clamp so that a stalled tab (or a breakpoint) does not queue thousands of
    // catch-up steps and freeze the app on resume.
    if (frameMs > MAX_FRAME_MS) frameMs = MAX_FRAME_MS

    const cpuStart = performance.now()

    this.accumulator += frameMs
    let steps = 0
    while (this.accumulator >= SIM_STEP_MS) {
      this.handlers.fixedUpdate(SIM_STEP_MS / 1000)
      this.accumulator -= SIM_STEP_MS
      steps++
    }

    const alpha = this.accumulator / SIM_STEP_MS
    this.handlers.render(alpha, frameMs / 1000)

    const cpuMs = performance.now() - cpuStart
    this.onTiming?.({ frameMs, cpuMs, steps })
  }
}
