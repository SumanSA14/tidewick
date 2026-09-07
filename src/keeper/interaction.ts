import type { IslandSnapshot } from '@/island/derive'
import { elevationFor, isBeachcombable, STAGE, NO_DUE_DATE, MS_PER_DAY, OVERDUE_FLOOR } from '@/island/derive'
import { sampleProfile, type RadialProfile } from '@/render/terrain/profile'
import { ELEVATION_HORIZON_DAYS } from '@/core/config'
import type { KeeperState } from './controller'

/**
 * What the Keeper can reach, and what happens when they act on it.
 *
 * This module is where Section 2's second half lives: the island is an *input*
 * surface, not only an output. Tending a plant completes the task; carrying a
 * plant uphill reschedules it. Both dispatch the same Command objects the DOM
 * interface dispatches - there is no island-only code path, which is exactly
 * what makes undo work identically from either side.
 *
 * Nothing here mutates anything. It reports what is in reach and translates a
 * world position back into a date; the caller builds the command.
 */

export interface Reachable {
  index: number
  pageId: string
  distance: number
  /** True when this plant is bobbing in the shallows, overdue. */
  beachcombable: boolean
  /** True when it is already a lantern - finished work, nothing to do. */
  finished: boolean
  x: number
  y: number
  z: number
}

/** How close the Keeper must be for the prompt to appear. */
export const REACH = 7.5

/**
 * The nearest interactable, or null.
 *
 * One target at a time, with a single context key, per Section 10. A radial
 * menu of everything nearby would be more capable and would also turn a quiet
 * walk into an inventory-management problem.
 */
export function nearestInteractable(
  keeper: KeeperState,
  snapshot: IslandSnapshot,
  profile: RadialProfile,
  now: number,
): Reachable | null {
  let best: Reachable | null = null

  for (let i = 0; i < snapshot.count; i++) {
    const point = plantPosition(snapshot, profile, i, now)
    const distance = Math.hypot(point.x - keeper.x, point.z - keeper.z)
    if (distance > REACH) continue
    if (best && distance >= best.distance) continue

    best = {
      index: i,
      pageId: snapshot.ids[i],
      distance,
      beachcombable: isBeachcombable(snapshot.due[i], now),
      finished: snapshot.stage[i] === STAGE.lantern,
      x: point.x,
      y: point.y,
      z: point.z,
    }
  }

  return best
}

/**
 * Where a plant currently stands.
 *
 * The same arithmetic the vertex shader uses, so the Keeper walks up to the
 * plant the player can see rather than to where the CPU thinks it might be.
 * Duplicating it is a real liability; the alternative is reading positions back
 * off the GPU every frame, which costs a stall to avoid a dozen lines.
 */
export function plantPosition(
  snapshot: IslandSnapshot,
  profile: RadialProfile,
  index: number,
  now: number,
): { x: number; y: number; z: number } {
  const level = elevationFor(snapshot.due[index], now)
  const sampled = sampleProfile(profile, snapshot.angle[index], Math.max(0, level))
  const jitter = snapshot.jitter[index]
  const angle = snapshot.angle[index] + (jitter - 0.5) * 0.16
  const radius = sampled.radius * (1 - jitter * 0.1)
  const submerged = Math.max(0, Math.min(1, -level / -OVERDUE_FLOOR))
  const y = sampled.height * (1 - submerged) + -1.1 * submerged
  return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius }
}

/**
 * The due date implied by standing here.
 *
 * The inverse of the elevation mechanic: `elevationFor` turns a date into a
 * height, and this turns a height back into a date. That is what makes
 * beachcombing work - you carry a plant up the slope and the act of putting it
 * down *is* the reschedule. Section 3.3 asks for rescheduling to feel like
 * rescue rather than failure, and this is the mechanism.
 */
export function dueDateForPosition(
  x: number,
  z: number,
  profile: RadialProfile,
  now: number,
  horizonDays = ELEVATION_HORIZON_DAYS,
): number {
  const angle = Math.atan2(z, x)
  const radius = Math.hypot(x, z)

  // The profile is indexed by elevation, so recovering a level from a radius
  // means walking it. 48 steps over a small table, once per drop.
  let level = 0
  for (let l = 0; l < profile.levels; l++) {
    const candidate = l / (profile.levels - 1)
    if (sampleProfile(profile, angle, candidate).radius >= radius) level = candidate
  }

  // Always at least tomorrow. Dropping a rescued plant at the waterline and
  // having it be overdue again on the spot would be a small cruelty.
  const days = Math.max(1, Math.round(level * horizonDays))
  return startOfDay(now + days * MS_PER_DAY)
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export type KeeperAction = 'tend' | 'pick-up' | 'put-down' | 'none'

/**
 * What the single context key would do right now.
 *
 * One key, one meaning at a time - so the prompt can say exactly what will
 * happen instead of listing options.
 */
export function actionFor(target: Reachable | null, carrying: string | null): KeeperAction {
  if (carrying) return 'put-down'
  if (!target) return 'none'
  if (target.beachcombable) return 'pick-up'
  if (target.finished) return 'none'
  return 'tend'
}

export function promptFor(action: KeeperAction, title: string): string {
  switch (action) {
    case 'tend': return `Tend ${title || 'this plant'}`
    case 'pick-up': return `Lift ${title || 'this plant'} from the shallows`
    case 'put-down': return 'Set it down here'
    default: return ''
  }
}

/** True when a plant has no date at all and lives in the meadow. */
export function isUndated(snapshot: IslandSnapshot, index: number): boolean {
  return snapshot.due[index] === NO_DUE_DATE
}
