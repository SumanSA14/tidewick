import { FOCUS_SESSION_MINUTES } from '@/core/config'
import { IDLE_AFTER_SECONDS, stepWarmth, accrue, WARMTH } from './economy'

/**
 * The focus session.
 *
 * A pure state machine over an injected clock, so a twenty-five minute session
 * can be tested in a millisecond and the idle and blur rules can be checked
 * exactly rather than by sitting and waiting.
 *
 * **The measurement is the product.** Section 5 says Sunlight accrues per
 * minute of *measured, uninterrupted* focus and from nothing else, so this
 * module's real job is to be honest about how much of a session was genuinely
 * spent working. It counts blurred and idle time separately and never pays for
 * it, which is why the island can be trusted as a record.
 */

export type FocusPhase = 'idle' | 'running' | 'paused' | 'finished'

export interface FocusSession {
  phase: FocusPhase
  /** Wall-clock ms when the session began. */
  startedAt: number
  /** Total seconds elapsed since start, whatever the user was doing. */
  elapsedSeconds: number
  /** Seconds that actually counted: running, focused and not idle. */
  focusedSeconds: number
  /** Seconds lost to a blurred window or an idle user. */
  driftedSeconds: number
  /** Target length in seconds. */
  targetSeconds: number
  /** The warmth multiplier, carried across the session. */
  warmth: number
  /** Sunlight earned so far this session. */
  earned: number
  /** True while the window has focus. */
  windowFocused: boolean
  /** Seconds since the last input. */
  idleSeconds: number
}

export interface FocusTick {
  /** Does the window have focus right now? */
  windowFocused: boolean
  /** Has the user done anything since the last tick? */
  activity: boolean
}

export function createSession(targetMinutes = FOCUS_SESSION_MINUTES, now = Date.now()): FocusSession {
  return {
    phase: 'idle',
    startedAt: now,
    elapsedSeconds: 0,
    focusedSeconds: 0,
    driftedSeconds: 0,
    targetSeconds: Math.max(60, targetMinutes * 60),
    warmth: WARMTH.base,
    earned: 0,
    windowFocused: true,
    idleSeconds: 0,
  }
}

export function start(session: FocusSession, now = Date.now()): FocusSession {
  if (session.phase === 'running') return session
  return {
    ...session,
    phase: 'running',
    startedAt: session.phase === 'paused' ? session.startedAt : now,
    // Resuming keeps the warmth it faded to rather than snapping back up:
    // Section 5 asks that the multiplier return gradually, never instantly.
    warmth: session.phase === 'paused' ? session.warmth : WARMTH.base,
  }
}

export function pause(session: FocusSession): FocusSession {
  if (session.phase !== 'running') return session
  return { ...session, phase: 'paused' }
}

/**
 * End a session early.
 *
 * **Keeps everything earned so far.** Stopping at twenty minutes is not a
 * failure and must not cost anything - guarantee 1. There is deliberately no
 * "abandoned" state and no penalty branch.
 */
export function stop(session: FocusSession): FocusSession {
  if (session.phase === 'idle') return session
  return { ...session, phase: 'finished' }
}

/**
 * Advance the session.
 *
 * `dt` is seconds of wall-clock. Time only counts as focus when the session is
 * running, the window has focus, and the user is not idle - all three, because
 * any one of them missing means the twenty-five minutes on the clock did not
 * happen.
 */
export function tickSession(session: FocusSession, tick: FocusTick, dt: number): FocusSession {
  if (session.phase !== 'running' || dt <= 0) return session

  const idleSeconds = tick.activity ? 0 : session.idleSeconds + dt
  const idle = idleSeconds >= IDLE_AFTER_SECONDS
  const counting = tick.windowFocused && !idle

  const warmth = stepWarmth(session.warmth, dt, counting)
  // Pay at the lower of the two ends of the slice, so a slice that begins
  // distracted is not paid at the rate it finishes at.
  const earned = counting ? accrue(dt, Math.min(session.warmth, warmth)) : 0

  const elapsedSeconds = session.elapsedSeconds + dt
  const next: FocusSession = {
    ...session,
    elapsedSeconds,
    focusedSeconds: session.focusedSeconds + (counting ? dt : 0),
    driftedSeconds: session.driftedSeconds + (counting ? 0 : dt),
    warmth,
    earned: session.earned + earned,
    windowFocused: tick.windowFocused,
    idleSeconds,
  }

  // The session ends on *focused* time, not on wall-clock: twenty-five minutes
  // of which ten were spent in another window is not a finished session, and
  // saying otherwise would be the tool lying to its user.
  if (next.focusedSeconds >= next.targetSeconds) next.phase = 'finished'
  return next
}

/** 0..1 across the session, by focused time. */
export function progressOf(session: FocusSession): number {
  return Math.max(0, Math.min(1, session.focusedSeconds / session.targetSeconds))
}

/** Seconds of focused work still to do. */
export function remainingSeconds(session: FocusSession): number {
  return Math.max(0, session.targetSeconds - session.focusedSeconds)
}

/** mm:ss for the timer face. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * How honest the session was, 0..1.
 *
 * Shown at the end as plain information, never as a grade. The keepsake says
 * "22 of 25 minutes" rather than "88%", because a percentage invites the user
 * to optimise it and that is not what this is for.
 */
export function attentionOf(session: FocusSession): number {
  const total = session.focusedSeconds + session.driftedSeconds
  return total <= 0 ? 1 : session.focusedSeconds / total
}
