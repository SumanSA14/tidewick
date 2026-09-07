import './keeper.css'

/**
 * The Keeper's on-screen text.
 *
 * Almost nothing, on purpose. Section 11 asks for calm, and a walking sim with
 * a quest log and a minimap is a different product. There is one line saying
 * what the context key will do, and a short set of controls that fades once
 * you have read it.
 *
 * The prompt names the outcome rather than the options - "Tend Two Sum", not
 * "[E] Interact" - because the player should never have to guess what a key
 * means while standing in front of something.
 */

export interface KeeperHUDProps {
  /** True while the Keeper is walking rather than the diorama orbiting. */
  walking: boolean
  /** What the context key would do, already phrased as an outcome. */
  prompt: string
  onToggleWalking: () => void
}

export function KeeperHUD({ walking, prompt, onToggleWalking }: KeeperHUDProps) {
  return (
    <>
      <button
        type="button"
        className={`keeper-toggle${walking ? ' keeper-toggle--on' : ''}`}
        onClick={onToggleWalking}
        aria-pressed={walking}
      >
        {walking ? 'Watch from above' : 'Walk the isle'}
        <kbd>V</kbd>
      </button>

      {walking && (
        <div className="keeper-controls" aria-hidden="true">
          <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk</span>
          <span><kbd>Shift</kbd> run</span>
          <span><kbd>Space</kbd> jump</span>
          <span>drag to look</span>
        </div>
      )}

      {/*
        Announced politely rather than assertively: the prompt changes whenever
        you walk past a plant, and an assertive live region would interrupt a
        screen reader mid-sentence every few steps.
      */}
      <div className="keeper-prompt" role="status" aria-live="polite">
        {walking && prompt && (
          <span className="keeper-prompt__body">
            <kbd>E</kbd> {prompt}
          </span>
        )}
      </div>
    </>
  )
}
