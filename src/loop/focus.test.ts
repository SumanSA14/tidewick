import { describe, it, expect } from 'vitest'
import {
  createSession, start, pause, stop, tickSession, progressOf,
  remainingSeconds, formatDuration, attentionOf,
} from './focus'
import { WARMTH, IDLE_AFTER_SECONDS } from './economy'
import { FOCUS_SESSION_MINUTES } from '@/core/config'

/**
 * The focus session.
 *
 * Phase 7's acceptance criteria name two behaviours specifically - "a 25-minute
 * session produces Sunlight and visibly warms the light" and "blurring the
 * window fades the multiplier" - so both are here as tests rather than as
 * something to check by sitting in front of it for half an hour.
 */

const FOCUSED = { windowFocused: true, activity: true }
const BLURRED = { windowFocused: false, activity: true }
const IDLE = { windowFocused: true, activity: false }

/** Run a session forward in one-second steps. */
function runFor(session: ReturnType<typeof createSession>, tick: typeof FOCUSED, seconds: number) {
  let s = session
  for (let i = 0; i < seconds; i++) s = tickSession(s, tick, 1)
  return s
}

describe('a 25 minute session', () => {
  it('produces Sunlight', () => {
    const done = runFor(start(createSession()), FOCUSED, FOCUS_SESSION_MINUTES * 60)
    expect(done.earned).toBeGreaterThan(0)
    // 25 minutes at a multiplier climbing from 1.0 toward the ceiling.
    expect(done.earned).toBeGreaterThan(FOCUS_SESSION_MINUTES)
    expect(done.earned).toBeLessThanOrEqual(FOCUS_SESSION_MINUTES * WARMTH.max)
  })

  it('visibly warms the light', () => {
    const session = start(createSession())
    const early = runFor(session, FOCUSED, 60)
    const late = runFor(early, FOCUSED, 10 * 60)
    expect(late.warmth).toBeGreaterThan(early.warmth)
    // "Visibly": a change too small to see would not satisfy the criterion.
    expect(late.warmth - early.warmth).toBeGreaterThan(0.2)
  })

  it('finishes when the focused time is done', () => {
    const done = runFor(start(createSession()), FOCUSED, FOCUS_SESSION_MINUTES * 60)
    expect(done.phase).toBe('finished')
    expect(progressOf(done)).toBe(1)
    expect(remainingSeconds(done)).toBe(0)
  })

  it('reaches the warmth ceiling and stops there', () => {
    const done = runFor(start(createSession(90)), FOCUSED, 60 * 60)
    expect(done.warmth).toBe(WARMTH.max)
  })
})

describe('blur fades the multiplier', () => {
  it('falls while the window is blurred', () => {
    const warmed = runFor(start(createSession()), FOCUSED, 5 * 60)
    const blurred = runFor(warmed, BLURRED, 60)
    expect(blurred.warmth).toBeLessThan(warmed.warmth)
  })

  it('earns nothing while blurred', () => {
    const warmed = runFor(start(createSession()), FOCUSED, 5 * 60)
    const blurred = runFor(warmed, BLURRED, 5 * 60)
    expect(blurred.earned).toBe(warmed.earned)
    expect(blurred.focusedSeconds).toBe(warmed.focusedSeconds)
    expect(blurred.driftedSeconds).toBe(5 * 60)
  })

  it('never falls to zero, however long the window is away', () => {
    const blurred = runFor(start(createSession(600)), BLURRED, 3 * 60 * 60)
    expect(blurred.warmth).toBe(WARMTH.min)
    expect(blurred.warmth).toBeGreaterThan(0)
  })

  it('returns gradually, not instantly', () => {
    // Section 5 is explicit: "returns gradually - never instantly, never
    // punitively". Snapping back would make the multiplier meaningless.
    const faded = runFor(start(createSession(600)), BLURRED, 10 * 60)
    expect(faded.warmth).toBe(WARMTH.min)

    const oneSecond = tickSession(faded, FOCUSED, 1)
    expect(oneSecond.warmth).toBeLessThan(WARMTH.base)

    const oneMinute = runFor(faded, FOCUSED, 60)
    expect(oneMinute.warmth).toBeGreaterThan(faded.warmth)
    expect(oneMinute.warmth).toBeLessThan(WARMTH.max)
  })
})

describe('idle detection', () => {
  it('keeps counting through a short pause for thought', () => {
    // Thinking is working. A timer that punishes you for not typing is a
    // typing timer, not a focus timer.
    const session = runFor(start(createSession()), IDLE, IDLE_AFTER_SECONDS - 5)
    expect(session.focusedSeconds).toBe(IDLE_AFTER_SECONDS - 5)
    expect(session.driftedSeconds).toBe(0)
  })

  it('stops counting once genuinely idle', () => {
    const session = runFor(start(createSession()), IDLE, IDLE_AFTER_SECONDS + 60)
    // One second short of the threshold: on the tick where idleSeconds first
    // reaches it, that second is already idle and does not count.
    expect(session.focusedSeconds).toBe(IDLE_AFTER_SECONDS - 1)
    expect(session.driftedSeconds).toBe(61)
  })

  it('resumes counting as soon as there is activity', () => {
    const idled = runFor(start(createSession()), IDLE, IDLE_AFTER_SECONDS + 60)
    const back = runFor(idled, FOCUSED, 60)
    expect(back.focusedSeconds).toBeGreaterThan(idled.focusedSeconds)
    expect(back.idleSeconds).toBe(0)
  })
})

describe('the clock is honest', () => {
  it('ends on focused time, not wall-clock', () => {
    // Twenty-five minutes of which ten were in another window is not a
    // finished session, and saying otherwise would be the tool lying.
    let session = start(createSession(25))
    session = runFor(session, FOCUSED, 15 * 60)
    session = runFor(session, BLURRED, 10 * 60)
    expect(session.elapsedSeconds).toBe(25 * 60)
    expect(session.phase).toBe('running')

    session = runFor(session, FOCUSED, 10 * 60)
    expect(session.phase).toBe('finished')
  })

  it('reports attention as a plain ratio', () => {
    let session = start(createSession(60))
    session = runFor(session, FOCUSED, 45 * 60)
    session = runFor(session, BLURRED, 15 * 60)
    expect(attentionOf(session)).toBeCloseTo(0.75, 2)
  })

  it('reports full attention for an untouched session', () => {
    expect(attentionOf(createSession())).toBe(1)
  })
})

describe('pause and resume', () => {
  it('accrues nothing while paused', () => {
    const running = runFor(start(createSession()), FOCUSED, 60)
    const paused = pause(running)
    const later = runFor(paused, FOCUSED, 10 * 60)
    expect(later.earned).toBe(running.earned)
    expect(later.elapsedSeconds).toBe(running.elapsedSeconds)
  })

  it('keeps the faded warmth when resumed', () => {
    const warmed = runFor(start(createSession()), FOCUSED, 5 * 60)
    const resumed = start(pause(warmed))
    expect(resumed.warmth).toBe(warmed.warmth)
    expect(resumed.phase).toBe('running')
  })

  it('keeps the original start time across a pause', () => {
    const session = start(createSession(25, 1000), 1000)
    const resumed = start(pause(session), 999_000)
    expect(resumed.startedAt).toBe(1000)
  })
})

describe('stopping early', () => {
  it('keeps what was earned', () => {
    const running = runFor(start(createSession()), FOCUSED, 10 * 60)
    const stopped = stop(running)
    expect(stopped.phase).toBe('finished')
    expect(stopped.earned).toBe(running.earned)
  })

  it('does nothing to a session that never started', () => {
    const fresh = createSession()
    expect(stop(fresh)).toBe(fresh)
  })
})

describe('the timer face', () => {
  it('formats mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(25 * 60)).toBe('25:00')
    expect(formatDuration(1500.4)).toBe('25:00')
  })

  it('never shows a negative time', () => {
    expect(formatDuration(-90)).toBe('0:00')
  })
})

describe('robustness', () => {
  it('ignores a zero or negative delta', () => {
    const session = start(createSession())
    expect(tickSession(session, FOCUSED, 0)).toBe(session)
    expect(tickSession(session, FOCUSED, -5)).toBe(session)
  })

  it('does not advance an idle session', () => {
    const fresh = createSession()
    expect(tickSession(fresh, FOCUSED, 10)).toBe(fresh)
  })

  it('enforces a sane minimum session length', () => {
    expect(createSession(0).targetSeconds).toBeGreaterThanOrEqual(60)
  })
})
