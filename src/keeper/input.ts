import type { KeeperInput } from './controller'

/**
 * Keyboard input for the Keeper.
 *
 * Separate from the controller so the simulation stays a pure function of an
 * input struct. That is what makes the movement testable without a DOM, and it
 * is also what will make a gamepad or touch stick a new producer of the same
 * struct rather than a second movement implementation.
 *
 * Keys are read from `event.code`, not `event.key`: `code` is physical, so WASD
 * stays under the same fingers on AZERTY and Dvorak. `key` would put a French
 * player's "forward" on Z.
 */

export interface InputBindings {
  forward: string[]
  back: string[]
  left: string[]
  right: string[]
  run: string[]
  jump: string[]
  interact: string[]
  /** Toggle back to the diorama overview. */
  overview: string[]
}

export const DEFAULT_BINDINGS: InputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  interact: ['KeyE', 'Enter'],
  /**
   * Not Tab. The app shell already owns Tab for the workspace/isle toggle, and
   * two handlers preventDefault-ing the same key is how one of them silently
   * stops working.
   */
  overview: ['KeyV'],
}

export class KeeperInputSource {
  private readonly held = new Set<string>()
  private readonly bindings: InputBindings
  private readonly target: HTMLElement | Window
  private disposed = false

  /** Rising-edge only: consumed by the reader, so one press is one action. */
  private interactPressed = false
  private overviewPressed = false
  private jumpPressed = false

  /** Set while a text field has focus, so typing never walks the Keeper. */
  private suspended = false

  onInteract: (() => void) | null = null
  onOverview: (() => void) | null = null

  constructor(target: HTMLElement | Window = window, bindings = DEFAULT_BINDINGS) {
    this.target = target
    this.bindings = bindings
    target.addEventListener('keydown', this.onKeyDown as EventListener)
    target.addEventListener('keyup', this.onKeyUp as EventListener)
    window.addEventListener('blur', this.onBlur)
  }

  /**
   * Stop responding to keys.
   *
   * The workspace and the island share a window, and the editor is a
   * contenteditable. Without this, typing "was" into a page title sprints the
   * Keeper off a cliff.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended
    if (suspended) this.held.clear()
  }

  /** Build the input struct for this frame. */
  sample(cameraYaw: number): KeeperInput {
    if (this.suspended) {
      return { strafe: 0, forward: 0, cameraYaw, run: false, jump: false }
    }

    const forward = this.axis(this.bindings.forward, this.bindings.back)
    const strafe = this.axis(this.bindings.right, this.bindings.left)
    const jump = this.jumpPressed
    this.jumpPressed = false

    return {
      strafe,
      forward,
      cameraYaw,
      run: this.anyHeld(this.bindings.run),
      jump,
    }
  }

  /** True once per press. */
  consumeInteract(): boolean {
    const pressed = this.interactPressed
    this.interactPressed = false
    return pressed
  }

  consumeOverview(): boolean {
    const pressed = this.overviewPressed
    this.overviewPressed = false
    return pressed
  }

  /** True when the player is asking the Keeper to move at all. */
  get moving(): boolean {
    if (this.suspended) return false
    return this.axis(this.bindings.forward, this.bindings.back) !== 0
      || this.axis(this.bindings.right, this.bindings.left) !== 0
  }

  private axis(positive: string[], negative: string[]): number {
    return (this.anyHeld(positive) ? 1 : 0) - (this.anyHeld(negative) ? 1 : 0)
  }

  private anyHeld(codes: string[]): boolean {
    for (const code of codes) if (this.held.has(code)) return true
    return false
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.suspended) return
    // Never swallow a browser or OS shortcut.
    if (event.ctrlKey || event.metaKey || event.altKey) return

    const code = event.code
    if (!this.isBound(code)) return

    // Space scrolls the page, which would be actively hostile mid-walk - but
    // only swallow it once the key is known to be one of ours.
    if (code === 'Space') event.preventDefault()

    if (!this.held.has(code)) {
      if (this.bindings.jump.includes(code)) this.jumpPressed = true
      if (this.bindings.interact.includes(code)) {
        this.interactPressed = true
        this.onInteract?.()
      }
      if (this.bindings.overview.includes(code)) {
        this.overviewPressed = true
        this.onOverview?.()
      }
    }
    this.held.add(code)
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code)
  }

  /**
   * Release everything when the window loses focus.
   *
   * Alt-tabbing mid-stride otherwise leaves the key logically held, and the
   * player comes back to a Keeper walking into the sea on their own.
   */
  private onBlur = (): void => {
    this.held.clear()
  }

  private isBound(code: string): boolean {
    for (const codes of Object.values(this.bindings)) {
      if (codes.includes(code)) return true
    }
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.held.clear()
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener)
    window.removeEventListener('blur', this.onBlur)
  }
}
