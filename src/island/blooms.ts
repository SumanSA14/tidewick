import { STAGE, type IslandSnapshot } from './derive'

/**
 * The bloom-and-lantern sequence.
 *
 * Section 5: "each completion gets one unhurried bloom-and-light sequence."
 *
 * **This is presentation, not derivation.** The snapshot says a task is done;
 * it does not and must not say "done 0.4 seconds ago", because that would put a
 * clock inside a pure function and make `derive()` untestable and unrepeatable.
 * So the bloom lives here: the Stage notices a plant *became* a lantern between
 * two snapshots and animates it, while the snapshot goes on stating the plain
 * fact that it is one.
 *
 * The animation needs no new instance attribute either. The plant shader
 * already ramps colour and scale across the stage value, so easing that one
 * number from sapling to lantern *is* the sequence - a plant swelling and
 * catching light. Reusing it costs one float per blooming plant per frame, and
 * a bloom affects one plant for a second and a half.
 */

/** How long a bloom takes. Unhurried: this is the reward, so it gets its time. */
export const BLOOM_SECONDS = 1.6

/** A plant mid-bloom. */
export interface Bloom {
  index: number
  /** Seconds on the Stage's own clock when the bloom began. */
  startedAt: number
}

/**
 * Which plants just became lanterns.
 *
 * Compared by page id rather than by index: rows are reordered, inserted and
 * removed, so index 4 in the new snapshot is very often a different task than
 * index 4 in the old one, and comparing by position would fire blooms for
 * plants nobody touched.
 */
export function newlyLit(
  previous: IslandSnapshot | null,
  next: IslandSnapshot,
  startedAt: number,
): Bloom[] {
  if (!previous || previous.count === 0) return []

  const wasLit = new Map<string, boolean>()
  for (let i = 0; i < previous.count; i++) {
    wasLit.set(previous.ids[i], previous.stage[i] === STAGE.lantern)
  }

  const blooms: Bloom[] = []
  for (let i = 0; i < next.count; i++) {
    if (next.stage[i] !== STAGE.lantern) continue
    const before = wasLit.get(next.ids[i])
    // Unknown means the plant is new to the island. A task that arrives
    // already complete - an import, or an undo - has not just been finished,
    // so it lights quietly rather than celebrating something that did not
    // happen in front of you.
    if (before === false) blooms.push({ index: i, startedAt })
  }
  return blooms
}

/**
 * The stage value to draw for a plant `elapsed` seconds into its bloom.
 *
 * Runs sapling → bloom → lantern. The overshoot in the middle is the swell:
 * the plant opens slightly past its final size before settling, which is what
 * makes it read as blooming rather than as growing.
 */
export function bloomStage(elapsed: number): number {
  const t = Math.max(0, Math.min(1, elapsed / BLOOM_SECONDS));
  if (t >= 1) return STAGE.lantern

  // Ease out: quick to open, slow to settle.
  const eased = 1 - (1 - t) ** 3
  const swell = Math.sin(t * Math.PI) * 0.35
  return STAGE.sapling + (STAGE.lantern - STAGE.sapling) * eased + swell
}

/** True once the bloom has finished and the plant can be left alone. */
export function bloomFinished(elapsed: number): boolean {
  return elapsed >= BLOOM_SECONDS
}
