/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KeeperInputSource, DEFAULT_BINDINGS } from './input'

/**
 * Input is tested through synthetic KeyboardEvents rather than through a real
 * browser, which is not only a convenience: the Browser pane in this
 * environment delivers blank key fields, so a manual check here would prove
 * nothing at all.
 */

let input: KeeperInputSource
let target: HTMLElement

function press(code: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function release(code: string) {
  target.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  input = new KeeperInputSource(target)
})

afterEach(() => {
  input.dispose()
  target.remove()
})

describe('keyboard input', () => {
  it('is still by default', () => {
    const sample = input.sample(0)
    expect(sample.forward).toBe(0)
    expect(sample.strafe).toBe(0)
    expect(sample.run).toBe(false)
  })

  it('reads WASD', () => {
    press('KeyW')
    expect(input.sample(0).forward).toBe(1)
    release('KeyW')
    press('KeyS')
    expect(input.sample(0).forward).toBe(-1)
    release('KeyS')
    press('KeyD')
    expect(input.sample(0).strafe).toBe(1)
    release('KeyD')
    press('KeyA')
    expect(input.sample(0).strafe).toBe(-1)
  })

  it('reads arrows too', () => {
    press('ArrowUp')
    expect(input.sample(0).forward).toBe(1)
  })

  it('uses physical key codes, so WASD survives a non-QWERTY layout', () => {
    // KeyW on AZERTY produces the character "z". Binding to event.key would
    // put a French player's forward on the wrong finger.
    expect(DEFAULT_BINDINGS.forward).toContain('KeyW')
    const event = new KeyboardEvent('keydown', { code: 'KeyW', key: 'z', bubbles: true })
    target.dispatchEvent(event)
    expect(input.sample(0).forward).toBe(1)
  })

  it('cancels opposing keys instead of picking a winner', () => {
    press('KeyW')
    press('KeyS')
    expect(input.sample(0).forward).toBe(0)
  })

  it('runs while shift is held', () => {
    press('KeyW')
    press('ShiftLeft')
    expect(input.sample(0).run).toBe(true)
    release('ShiftLeft')
    expect(input.sample(0).run).toBe(false)
  })

  it('passes the camera yaw straight through', () => {
    expect(input.sample(1.25).cameraYaw).toBe(1.25)
  })

  describe('edge-triggered actions', () => {
    it('jumps once per press, not once per frame', () => {
      press('Space')
      expect(input.sample(0).jump).toBe(true)
      // Key still held, but the jump has been consumed.
      expect(input.sample(0).jump).toBe(false)
      expect(input.sample(0).jump).toBe(false)
    })

    it('jumps again after releasing and pressing', () => {
      press('Space')
      input.sample(0)
      release('Space')
      press('Space')
      expect(input.sample(0).jump).toBe(true)
    })

    it('fires interact once per press', () => {
      const onInteract = vi.fn()
      input.onInteract = onInteract
      press('KeyE')
      press('KeyE') // auto-repeat
      expect(onInteract).toHaveBeenCalledTimes(1)
      expect(input.consumeInteract()).toBe(true)
      expect(input.consumeInteract()).toBe(false)
    })

    it('fires the overview toggle once per press', () => {
      const onOverview = vi.fn()
      input.onOverview = onOverview
      press('KeyV')
      expect(onOverview).toHaveBeenCalledTimes(1)
      expect(input.consumeOverview()).toBe(true)
    })
  })

  describe('living alongside the workspace UI', () => {
    it('stops walking the Keeper while a text field has focus', () => {
      // Typing "was" into a page title must not sprint the Keeper off a cliff.
      press('KeyW')
      expect(input.sample(0).forward).toBe(1)

      input.setSuspended(true)
      expect(input.sample(0).forward).toBe(0)
      expect(input.moving).toBe(false)

      // And keys pressed while suspended do not queue up for later.
      press('KeyD')
      input.setSuspended(false)
      expect(input.sample(0).strafe).toBe(0)
    })

    it('leaves browser and OS shortcuts alone', () => {
      const event = press('KeyW', { ctrlKey: true })
      expect(input.sample(0).forward).toBe(0)
      expect(event.defaultPrevented).toBe(false)
    })

    it('swallows space, but leaves Tab to the app shell', () => {
      expect(press('Space').defaultPrevented).toBe(true)
      // The app shell toggles workspace/isle with Tab; two handlers
      // preventDefault-ing the same key is how one silently stops working.
      expect(press('Tab').defaultPrevented).toBe(false)
      // An unbound key is left entirely alone.
      expect(press('KeyQ').defaultPrevented).toBe(false)
    })

    it('releases everything when the window loses focus', () => {
      // Alt-tabbing mid-stride otherwise leaves the Keeper walking into the sea.
      press('KeyW')
      expect(input.moving).toBe(true)
      window.dispatchEvent(new Event('blur'))
      expect(input.moving).toBe(false)
    })
  })

  it('goes quiet after dispose', () => {
    press('KeyW')
    input.dispose()
    expect(input.sample(0).forward).toBe(0)
    press('KeyW')
    expect(input.sample(0).forward).toBe(0)
  })
})
