import { formatDuration, progressOf, remainingSeconds, attentionOf, type FocusSession } from './focus'
import './loop.css'

/**
 * The focus timer.
 *
 * A ring, a time and one button. Section 11 asks for calm, and the thing this
 * competes with is a Pomodoro app with a settings panel and a statistics tab.
 *
 * **Nothing here is red and nothing counts down urgently.** The ring fills
 * rather than drains, because a draining ring is a deadline and a filling one
 * is progress - the same information, opposite feeling. That is Section 17's
 * "no countdown urgency" taken literally.
 */

export interface FocusTimerProps {
  session: FocusSession
  running: boolean
  sunlight: number
  onBegin: () => void
  onHold: () => void
  onEnd: () => void
}

const RADIUS = 26
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function FocusTimer({ session, running, sunlight, onBegin, onHold, onEnd }: FocusTimerProps) {
  const progress = progressOf(session)
  const idle = session.phase === 'idle'
  const finished = session.phase === 'finished'
  const drifting = running && (!session.windowFocused || session.idleSeconds > 30)

  return (
    <section className={`focus${running ? ' focus--running' : ''}`} aria-label="Focus session">
      <div className="focus__dial">
        <svg viewBox="0 0 64 64" className="focus__ring" aria-hidden="true">
          <circle className="focus__track" cx="32" cy="32" r={RADIUS} />
          <circle
            className="focus__fill"
            cx="32" cy="32" r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            // Filling, never draining.
            strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          />
        </svg>
        <span className="focus__time">
          {finished ? 'done' : formatDuration(remainingSeconds(session))}
        </span>
      </div>

      <div className="focus__body">
        <p className="focus__label">
          {idle && 'Focus'}
          {running && (drifting ? 'Waiting for you' : 'Tending the light')}
          {session.phase === 'paused' && 'Paused'}
          {finished && 'Session complete'}
        </p>

        {/*
          Sunlight is shown as a quiet number rather than a growing bar with a
          next threshold on it. There is nothing to reach, so implying a target
          would be a lie.
        */}
        <p className="focus__sun">
          {sunlight >= 1 ? `${Math.floor(sunlight)} sunlight` : 'no sunlight yet'}
          {finished && session.driftedSeconds > 60 && (
            <span className="focus__aside">
              {' · '}
              {Math.round(session.focusedSeconds / 60)} of{' '}
              {Math.round((session.focusedSeconds + session.driftedSeconds) / 60)} minutes
            </span>
          )}
        </p>
      </div>

      <div className="focus__actions">
        {!running && (
          <button type="button" className="focus__button focus__button--go" onClick={onBegin}>
            {finished || idle ? 'Begin' : 'Resume'}
          </button>
        )}
        {running && (
          <button type="button" className="focus__button" onClick={onHold}>
            Pause
          </button>
        )}
        {!idle && !finished && (
          <button type="button" className="focus__button focus__button--quiet" onClick={onEnd}>
            {/*
              "Finish", not "Give up" or "Abandon". Stopping at twenty minutes
              keeps every minute of it, and the word on the button should say so.
            */}
            Finish
          </button>
        )}
      </div>

      {/* Announced politely: a live region that interrupts is the opposite of calm. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {finished
          ? `Session complete. ${Math.round(session.focusedSeconds / 60)} minutes of focus, ${Math.round(attentionOf(session) * 100)} per cent attended.`
          : ''}
      </p>
    </section>
  )
}
