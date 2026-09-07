/**
 * Sunlight — the only resource.
 *
 * ============================================================================
 * THE COZY GUARANTEES (Section 3.6). These are not aspirations. They are
 * invariants of this module and of `loopCommands.ts`, each one enforced by the
 * code below and asserted in `guarantees.test.ts` - which is written
 * adversarially, trying to find the fail state and farm the currency, and
 * passes only when it cannot.
 *
 *   1. NO FAIL STATE. Nothing here can reach a losing condition. Sunlight
 *      floors at zero; neglect produces sleepiness and moss, never ruin.
 *
 *   2. ALL DECAY IS CAPPED AND REVERSIBLE. `decayFor` cannot return more than
 *      DECAY_FLOOR of the island's warmth however long you stay away, and any
 *      focus at all begins restoring it. Three weeks away is a quiet, overgrown
 *      island you are glad to come back to.
 *
 *   3. NOTHING HERE MAY DELETE, HIDE OR CORRUPT REAL DATA. Every function in
 *      this module is pure arithmetic over numbers - it never receives the
 *      workspace and so cannot reach a page, a block or a database at all. The
 *      commands that do write only ever touch four fields on `meta`, and the
 *      only one that adds anything to the tree is the harvest keepsake.
 *
 *   4. NEVER REWARD TASK CREATION. There is no accrual path from creating,
 *      editing, browsing or wandering. `accrue()` takes measured focus seconds
 *      and nothing else. Rewarding creation would produce task-spam and make
 *      the tool lie to its user.
 *
 *   5. DELETING A TASK IS NEUTRAL. Nothing here charges for removal, and
 *      `lanternsLit` never decreases. Dropping something is often the correct
 *      decision and must never cost anything.
 *
 *   6. NO PURCHASABLE, GRINDABLE OR CLICKABLE CURRENCY. Sunlight has exactly
 *      one source - measured, uninterrupted focus time - and clicking faster
 *      cannot produce more of it. There is no shop and no conversion.
 *
 * Because Sunlight can only come from real focus time, the island is an honest
 * record. That honesty is the product, and every one of the six above exists to
 * protect it.
 * ============================================================================
 */

import type { WorkspaceMeta } from '@/state/types'

/** Sunlight per minute of focus at the base multiplier. */
export const SUNLIGHT_PER_MINUTE = 1

/**
 * The warmth multiplier.
 *
 * Rises while focus is genuinely sustained and fades when it is not. It never
 * reaches zero: a distracted session still counts for something, because a
 * punitive floor would turn a gentle loop into a chore.
 */
export const WARMTH = {
  min: 0.35,
  base: 1,
  max: 1.5,
  /** Multiplier gained per minute of unbroken focus. */
  risePerMinute: 0.14,
  /**
   * Multiplier lost per minute while blurred or idle.
   *
   * Faster than the rise, because attention genuinely does break faster than
   * it builds - but bounded by `min`, so it fades rather than punishes.
   */
  fallPerMinute: 0.5,
} as const

/** Seconds of no input before a session counts as idle. */
export const IDLE_AFTER_SECONDS = 90

/**
 * The island's warmth never falls below this fraction, however long you are
 * away. Guarantee 2: capped and reversible.
 */
export const DECAY_FLOOR = 0.55

/** Days of absence over which warmth eases down to the floor. */
export const DECAY_OVER_DAYS = 21

/** Sunlight one bloom costs. Cosmetic only - see `spendOnBloom`. */
export const BLOOM_COST = 2

const MS_PER_DAY = 86_400_000

export interface EconomyMeta {
  sunlight: number
  focusMinutes: number
  lanternsLit: number
  warmth: number
}

/**
 * Advance the warmth multiplier over a slice of time.
 *
 * `focused` means the session is running, the window has focus and the user is
 * not idle. Pure, and takes a delta rather than reading a clock, so the tests
 * can walk it a minute at a time.
 */
export function stepWarmth(current: number, seconds: number, focused: boolean): number {
  const minutes = seconds / 60
  const next = focused
    ? current + WARMTH.risePerMinute * minutes
    : current - WARMTH.fallPerMinute * minutes
  return clamp(next, WARMTH.min, WARMTH.max)
}

/**
 * Sunlight earned by a slice of measured focus.
 *
 * **Guarantee 4 and 6 live here.** The only argument that can increase the
 * result is time actually spent focused. There is deliberately no parameter
 * for tasks created, edits made, or anything a user could click faster to
 * farm - because if one existed, someone would find it, and the island would
 * stop being an honest record.
 */
export function accrue(focusSeconds: number, warmth: number): number {
  if (!Number.isFinite(focusSeconds) || focusSeconds <= 0) return 0
  const minutes = focusSeconds / 60
  return minutes * SUNLIGHT_PER_MINUTE * clamp(warmth, WARMTH.min, WARMTH.max)
}

/**
 * Spend Sunlight on a completion bloom.
 *
 * **This can never block the completion.** Returns what was actually spent;
 * with an empty reserve that is zero and the task still completes, just
 * without the flourish. Gating real work behind a resource would be a fail
 * state wearing a friendly hat (guarantees 1 and 3).
 */
export function spendOnBloom(sunlight: number, cost = BLOOM_COST): { spent: number; left: number } {
  const spent = Math.max(0, Math.min(sunlight, cost))
  return { spent, left: Math.max(0, sunlight - spent) }
}

/**
 * How warm the island is after an absence.
 *
 * **Guarantee 2.** Eases from full warmth toward `DECAY_FLOOR` over
 * `DECAY_OVER_DAYS` and then stops. There is no length of absence that
 * produces a dead island, and returning restores it - the curve is a function
 * of "days since last seen", so one visit resets it completely.
 */
export function decayFor(lastOpenedAt: number, now: number): number {
  const days = Math.max(0, (now - lastOpenedAt) / MS_PER_DAY)
  const t = Math.min(1, days / DECAY_OVER_DAYS)
  // Smoothstep, gentle at both ends. An ease-*out* here was the first attempt
  // and it did the opposite of what it claimed: it falls fastest at the start,
  // so a weekend away cost 8% of the island's warmth. This is the difference
  // between a weekend and a punishment.
  const eased = t * t * (3 - 2 * t)
  return 1 - eased * (1 - DECAY_FLOOR)
}

/**
 * Apply a slice of focus to the workspace's economy fields.
 *
 * Returns a new object rather than mutating: this runs inside a command, and
 * the command owns the draft.
 */
export function applyFocus(
  meta: EconomyMeta,
  focusSeconds: number,
  focused: boolean,
): EconomyMeta {
  const warmth = stepWarmth(meta.warmth, focusSeconds, focused)
  // Accrue against the warmth at the *end* of the slice, so a slice that
  // started distracted does not pay out at the rate it finished at.
  const earned = focused ? accrue(focusSeconds, Math.min(meta.warmth, warmth)) : 0
  return {
    sunlight: meta.sunlight + earned,
    focusMinutes: meta.focusMinutes + (focused ? focusSeconds / 60 : 0),
    lanternsLit: meta.lanternsLit,
    warmth,
  }
}

/** Read the economy fields off workspace meta. */
export function economyOf(meta: WorkspaceMeta): EconomyMeta {
  return {
    sunlight: meta.sunlight ?? 0,
    focusMinutes: meta.focusMinutes ?? 0,
    lanternsLit: meta.lanternsLit ?? 0,
    warmth: meta.warmth ?? WARMTH.base,
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
