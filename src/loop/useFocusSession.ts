import { useCallback, useEffect, useRef, useState } from 'react'
import { FOCUS_SESSION_MINUTES } from '@/core/config'
import { useWorkspaceStore } from '@/state/store'
import {
  createSession, start, pause, stop, tickSession, progressOf,
  type FocusSession,
} from './focus'
import { goldenDepth } from './goldenHour'
import { WARMTH } from './economy'
import { BankFocus } from './loopCommands'

/**
 * The focus session, wired to the browser.
 *
 * The session itself is a pure state machine; this is the only part that knows
 * about `document.hidden`, pointer events and `requestAnimationFrame`, which is
 * why the twenty-five minute behaviour could be tested in a millisecond.
 *
 * **Time is measured against the wall clock, not accumulated from frame
 * deltas.** A background tab throttles rAF to once a second or stops it
 * entirely, so summing deltas would quietly under-count exactly the situation
 * the blur rule exists to catch. Reading `Date.now()` each tick makes the
 * measurement honest whatever the browser decides to do with the timer.
 */

/** How often the session is advanced. Once a second is plenty for a timer. */
const TICK_MS = 1000

export interface FocusController {
  session: FocusSession
  running: boolean
  /** 0..1 golden-hour depth, for the island's lighting. */
  golden: number
  begin: () => void
  hold: () => void
  end: () => void
}

export function useFocusSession(minutes = FOCUS_SESSION_MINUTES): FocusController {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const [session, setSession] = useState<FocusSession>(() => createSession(minutes))

  // Kept in refs so the interval closes over live values without restarting.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const lastTickRef = useRef(0)
  const activityRef = useRef(false)
  const bankedRef = useRef(false)

  /** Any of these counts as being at the desk. */
  useEffect(() => {
    const seen = () => { activityRef.current = true }
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'scroll'] as const
    for (const type of events) window.addEventListener(type, seen, { passive: true })
    return () => {
      for (const type of events) window.removeEventListener(type, seen)
    }
  }, [])

  const bank = useCallback((finished: FocusSession) => {
    // Guard against banking twice: a session can finish on its own and then be
    // stopped by the user in the same second.
    if (bankedRef.current) return
    if (finished.focusedSeconds <= 0) return
    bankedRef.current = true
    dispatch(new BankFocus(finished.focusedSeconds, finished.earned, finished.warmth))
  }, [dispatch])

  useEffect(() => {
    if (session.phase !== 'running') return

    lastTickRef.current = Date.now()
    const id = window.setInterval(() => {
      const now = Date.now()
      // Wall clock, not a fixed increment: a throttled or suspended tab must
      // not be able to pass as focused time.
      const dt = Math.min(120, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now

      const activity = activityRef.current
      activityRef.current = false

      const next = tickSession(sessionRef.current, {
        // `document.hidden` covers a minimised window and a background tab;
        // `document.hasFocus()` also catches another window on top of this one,
        // which is the common case and the one the criterion names.
        windowFocused: !document.hidden && document.hasFocus(),
        activity,
      }, dt)

      setSession(next)
      if (next.phase === 'finished') bank(next)
    }, TICK_MS)

    return () => window.clearInterval(id)
  }, [session.phase, bank])

  const begin = useCallback(() => {
    bankedRef.current = false
    setSession((s) => start(s.phase === 'finished' ? createSession(minutes) : s))
  }, [minutes])

  const hold = useCallback(() => setSession((s) => pause(s)), [])

  const end = useCallback(() => {
    setSession((s) => {
      const stopped = stop(s)
      bank(stopped)
      return stopped
    })
  }, [bank])

  return {
    session,
    running: session.phase === 'running',
    golden: session.phase === 'running'
      ? goldenDepth(progressOf(session), session.warmth, WARMTH.base)
      : 0,
    begin,
    hold,
    end,
  }
}
