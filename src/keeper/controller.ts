/**
 * The Keeper's movement.
 *
 * Deliberately free of three.js and of any renderer type, so it can be tested
 * against a synthetic hillside rather than against the real island. Everything
 * it needs from the world arrives through `GroundSampler`.
 *
 * There is no physics engine and no navmesh, because the terrain *is* a
 * heightfield: "where is the floor" is a lookup, not a query. Section 10 is
 * explicit about this and it is the right call - a rigid-body solver here would
 * be several hundred kilobytes to answer a question the terrain already knows.
 */

export interface GroundSampler {
  /** Terrain height at a world position. Sea level where there is no land. */
  heightAt(x: number, z: number): number
  /** False out at sea, where the Keeper wades instead of walking. */
  isLand(x: number, z: number): boolean
}

export interface KeeperInput {
  /** -1..1, left/right relative to the camera. */
  strafe: number
  /** -1..1, back/forward relative to the camera. */
  forward: number
  /** Camera yaw in radians, so movement is relative to what you can see. */
  cameraYaw: number
  run: boolean
  jump: boolean
}

export interface KeeperState {
  x: number
  y: number
  z: number
  /** Vertical velocity only; horizontal is derived fresh each step. */
  velocityY: number
  /** Horizontal velocity, kept so acceleration can be gradual. */
  velocityX: number
  velocityZ: number
  /** Facing, radians. Turns toward movement rather than snapping. */
  yaw: number
  grounded: boolean
  /** Seconds since last grounded, for coyote time. */
  airborne: number
  /** True when standing in water shallower than wading depth. */
  wading: boolean
}

export const KEEPER = {
  walkSpeed: 9,
  runSpeed: 16,
  /** Wading is slower, which is what makes beachcombing feel deliberate. */
  wadeSpeed: 5,
  acceleration: 60,
  friction: 42,
  gravity: -38,
  jumpSpeed: 14,
  /** How long after leaving the ground a jump still counts. */
  coyoteTime: 0.12,
  turnRate: 12,
  /**
   * How high a step the Keeper can climb.
   *
   * Generous on purpose. A band on this island is over two metres, so a
   * realistic step height would make most of the isle unreachable and the
   * Keeper would spend the game walking into walls. Section 10 asks for a step
   * offset; on terraced terrain the honest value is "one terrace".
   */
  stepOffset: 2.6,
  /** Below this depth the Keeper wades; deeper is simply not entered. */
  wadeDepth: 1.6,
  radius: 1.1,
  /**
   * Drawn height, in world units. Render-only; the controller collides on
   * `radius` and steps on `stepOffset`.
   *
   * Nothing in this world is in metres - the peak is 24 units and a seedling
   * is 10 - so the Keeper is sized against the island rather than against a
   * person. At 3.4 they were a bead beside their own plants.
   */
  height: 6.4,
} as const

/** Sea level. The waterline the whole elevation mechanic is measured from. */
export const WATER_LEVEL = 0

export function createKeeper(x = 0, z = 0, sampler?: GroundSampler): KeeperState {
  return {
    x,
    y: sampler ? sampler.heightAt(x, z) : 0,
    z,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    yaw: 0,
    grounded: true,
    airborne: 0,
    wading: false,
  }
}

/**
 * Advance one fixed step.
 *
 * Mutates and returns the same object: this runs at 60 Hz inside the fixed
 * loop, and allocating a fresh state sixty times a second to be immutable
 * about a struct nobody else holds is a cost with no benefit.
 */
export function stepKeeper(
  state: KeeperState,
  input: KeeperInput,
  sampler: GroundSampler,
  dt: number,
): KeeperState {
  // --- desired horizontal velocity, in world space -------------------------
  const magnitude = Math.min(1, Math.hypot(input.strafe, input.forward))
  let desiredX = 0
  let desiredZ = 0

  if (magnitude > 0.001) {
    // Camera-relative: forward is where the camera looks, not where the world
    // happens to point. Anything else and the controls fight the camera.
    const sin = Math.sin(input.cameraYaw)
    const cos = Math.cos(input.cameraYaw)
    const dirX = input.strafe * cos + input.forward * sin
    const dirZ = -input.strafe * sin + input.forward * cos
    const length = Math.hypot(dirX, dirZ) || 1

    const speed = state.wading
      ? KEEPER.wadeSpeed
      : input.run ? KEEPER.runSpeed : KEEPER.walkSpeed
    desiredX = (dirX / length) * speed * magnitude
    desiredZ = (dirZ / length) * speed * magnitude
  }

  // Accelerate toward the target rather than snapping to it, so starting and
  // stopping have weight. Friction is stronger than acceleration, which is
  // what makes the Keeper feel unhurried rather than slippery.
  const rate = magnitude > 0.001 ? KEEPER.acceleration : KEEPER.friction
  state.velocityX = approach(state.velocityX, desiredX, rate * dt)
  state.velocityZ = approach(state.velocityZ, desiredZ, rate * dt)

  // --- horizontal movement, one axis at a time -----------------------------
  // Separately, so walking into a cliff at an angle slides along it instead of
  // stopping dead - which is the difference between a controller that feels
  // stuck and one that feels solid.
  const nextX = tryMove(state, sampler, state.x + state.velocityX * dt, state.z)
  if (!nextX) state.velocityX = 0
  else state.x = nextX.x

  const nextZ = tryMove(state, sampler, state.x, state.z + state.velocityZ * dt)
  if (!nextZ) state.velocityZ = 0
  else state.z = nextZ.z

  // --- face the direction of travel ---------------------------------------
  if (Math.hypot(state.velocityX, state.velocityZ) > 0.4) {
    const target = Math.atan2(state.velocityX, state.velocityZ)
    state.yaw = turnToward(state.yaw, target, KEEPER.turnRate * dt)
  }

  // --- vertical ------------------------------------------------------------
  const ground = groundHeightFor(sampler, state.x, state.z)
  state.wading = !sampler.isLand(state.x, state.z) || ground < WATER_LEVEL - 0.01

  const canJump = state.grounded || state.airborne < KEEPER.coyoteTime
  if (input.jump && canJump) {
    state.velocityY = KEEPER.jumpSpeed
    state.grounded = false
    // Consuming the coyote window prevents a second jump from the same one.
    state.airborne = KEEPER.coyoteTime
  }

  state.velocityY += KEEPER.gravity * dt
  state.y += state.velocityY * dt

  const floor = state.wading ? WATER_LEVEL - KEEPER.wadeDepth * 0.35 : ground
  if (state.y <= floor) {
    state.y = floor
    state.velocityY = 0
    state.grounded = true
    state.airborne = 0
  } else {
    state.grounded = false
    state.airborne += dt
  }

  return state
}

/**
 * Can the Keeper stand here?
 *
 * Returns the accepted position, or null when the step up is too tall or the
 * water too deep. Sampling a ring around the centre rather than a single point
 * is what stops the capsule from clipping a corner of a terrace.
 */
function tryMove(
  state: KeeperState,
  sampler: GroundSampler,
  x: number,
  z: number,
): { x: number; z: number } | null {
  const ground = groundHeightFor(sampler, x, z)

  // Too deep to wade into. The shallows are walkable; the sea is not.
  if (!sampler.isLand(x, z) && WATER_LEVEL - ground > KEEPER.wadeDepth) {
    // Only refuse if the Keeper is not already out there - otherwise someone
    // who ends up in deep water can never get back to shore.
    if (sampler.isLand(state.x, state.z)) return null
  }

  // A step up taller than the offset is a wall. Falling is always allowed.
  const rise = ground - state.y
  if (rise > KEEPER.stepOffset && state.grounded) return null

  // Check the leading edge of the capsule too, not just its centre.
  const dx = x - state.x
  const dz = z - state.z
  const length = Math.hypot(dx, dz)
  if (length > 1e-5) {
    const edgeX = x + (dx / length) * KEEPER.radius
    const edgeZ = z + (dz / length) * KEEPER.radius
    const edge = groundHeightFor(sampler, edgeX, edgeZ)
    if (edge - state.y > KEEPER.stepOffset && state.grounded) return null
  }

  return { x, z }
}

function groundHeightFor(sampler: GroundSampler, x: number, z: number): number {
  return sampler.isLand(x, z) ? sampler.heightAt(x, z) : WATER_LEVEL - KEEPER.wadeDepth
}

function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) return target
  return current + Math.sign(delta) * maxDelta
}

/** Turn toward an angle by at most `maxDelta`, taking the short way round. */
export function turnToward(current: number, target: number, maxDelta: number): number {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  if (Math.abs(delta) <= maxDelta) return normaliseAngle(target)
  return normaliseAngle(current + Math.sign(delta) * maxDelta)
}

export function normaliseAngle(angle: number): number {
  const twoPi = Math.PI * 2
  return ((angle % twoPi) + twoPi) % twoPi
}

/** Horizontal speed, for the animation state machine. */
export function speedOf(state: KeeperState): number {
  return Math.hypot(state.velocityX, state.velocityZ)
}
