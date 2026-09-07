import type { TerracedField } from '@/render/terrain/terrace'
import type { RadialProfile } from '@/render/terrain/profile'
import type { IslandSnapshot } from '@/island/derive'
import { EMPTY_SNAPSHOT } from '@/island/derive'
import {
  createKeeper, stepKeeper, speedOf,
  type GroundSampler, type KeeperInput, type KeeperState,
} from './controller'
import { createAnimation, stepAnimation, blendedPose, SIT_AFTER_SECONDS, type AnimationState, type KeeperPose } from './animation'
import { createGroundSampler, findFooting } from './ground'
import {
  nearestInteractable, actionFor, promptFor, dueDateForPosition,
  type Reachable, type KeeperAction,
} from './interaction'

/**
 * The Keeper, assembled.
 *
 * Owns the movement state, the animation machine, what is being carried and
 * what is in reach, and nothing else - no meshes, no renderer, no store. The
 * Stage drives it and draws it; the app turns its intents into commands.
 *
 * That last part is the important one. This does not import the store and does
 * not build commands, because Section 2 requires that the island dispatch the
 * *same* Command objects the DOM interface does. Emitting an intent and letting
 * the app construct the command is what keeps that true: there is one place
 * that knows how to complete a task, and it is not here.
 */

/** How long the tend animation runs before the intent fires. */
const TEND_SECONDS = 0.9

export interface KeeperIntents {
  /** Mark this page's task complete. The app builds the command. */
  onTend: ((pageId: string) => void) | null
  /** Move this page's due date, because it was set down at this elevation. */
  onReschedule: ((pageId: string, dueMillis: number) => void) | null
  /** Reach state changed; the app updates the on-screen prompt. */
  onPromptChange: ((prompt: string, action: KeeperAction) => void) | null
}

export interface KeeperStatus {
  action: KeeperAction
  prompt: string
  target: Reachable | null
  carrying: string | null
  wading: boolean
}

export class KeeperSystem implements KeeperIntents {
  readonly state: KeeperState = createKeeper()
  readonly animation: AnimationState = createAnimation()

  onTend: ((pageId: string) => void) | null = null
  onReschedule: ((pageId: string, dueMillis: number) => void) | null = null
  onPromptChange: ((prompt: string, action: KeeperAction) => void) | null = null

  private sampler: GroundSampler | null = null
  private profile: RadialProfile | null = null
  private snapshot: IslandSnapshot = EMPTY_SNAPSHOT

  private carrying: string | null = null
  private target: Reachable | null = null
  private action: KeeperAction = 'none'
  private prompt = ''

  private tendTimer = 0
  private tendingPage: string | null = null
  private stillSeconds = 0

  /** Injected so tests are not at the mercy of the wall clock. */
  now: () => number = () => Date.now()

  /**
   * Page title for the prompt.
   *
   * A resolver rather than a field on the snapshot: the snapshot is rebuilt
   * and transferred out of a worker on every derive, and copying every page
   * title through that boundary to render one line of prompt text would be a
   * poor trade. The app has the store; it can answer.
   */
  titleFor: ((pageId: string) => string) | null = null

  get sampled(): GroundSampler | null {
    return this.sampler
  }

  get status(): KeeperStatus {
    return {
      action: this.action,
      prompt: this.prompt,
      target: this.target,
      carrying: this.carrying,
      wading: this.state.wading,
    }
  }

  get pose(): KeeperPose {
    return blendedPose(this.animation)
  }

  get isCarrying(): boolean {
    return this.carrying !== null
  }

  /**
   * Hand the Keeper a new island.
   *
   * Called on first terrain and on every regeneration. A workspace rename
   * reseeds the terrain, so the ground the Keeper was standing on may simply
   * not be land any more - hence the re-footing rather than leaving them where
   * they were.
   */
  setField(field: TerracedField): void {
    this.sampler = createGroundSampler(field)
    const footing = findFooting(field, this.state.x, this.state.z)
    this.state.x = footing.x
    this.state.z = footing.z
    this.state.y = this.sampler.heightAt(footing.x, footing.z)
    this.state.velocityX = 0
    this.state.velocityY = 0
    this.state.velocityZ = 0
    this.state.grounded = true
  }

  setProfile(profile: RadialProfile | null): void {
    this.profile = profile
  }

  setSnapshot(snapshot: IslandSnapshot): void {
    this.snapshot = snapshot
    // What was being carried may have been deleted from the workspace while it
    // was in hand. Dropping it silently is better than carrying a ghost.
    if (this.carrying && !snapshot.ids.includes(this.carrying)) {
      this.carrying = null
    }
  }

  /** One fixed simulation step. */
  fixedUpdate(input: KeeperInput, dt: number): void {
    if (!this.sampler) return

    // Mid-tend the Keeper is committed: the action has weight because you
    // cannot walk out of it halfway.
    const effective: KeeperInput = this.tendingPage
      ? { ...input, strafe: 0, forward: 0, run: false, jump: false }
      : input

    stepKeeper(this.state, effective, this.sampler, dt)

    if (speedOf(this.state) > 0.35) this.stillSeconds = 0
    else this.stillSeconds += dt

    this.advanceTend(dt)

    stepAnimation(this.animation, this.state, {
      carrying: this.carrying !== null,
      tending: this.tendingPage !== null,
      resting: this.stillSeconds > SIT_AFTER_SECONDS,
    }, dt)

    this.refreshTarget()
  }

  /**
   * Act on whatever is in reach.
   *
   * One key, one meaning - the action was already decided by `actionFor`, so
   * this cannot disagree with the prompt the player is reading.
   */
  interact(): void {
    switch (this.action) {
      case 'tend':
        if (!this.target) return
        this.tendingPage = this.target.pageId
        this.tendTimer = 0
        break

      case 'pick-up':
        if (!this.target) return
        this.carrying = this.target.pageId
        break

      case 'put-down': {
        const pageId = this.carrying
        this.carrying = null
        if (!pageId || !this.profile) break
        // Setting it down *is* the reschedule: the elevation you chose is the
        // date. Section 3.3 - rescue, not failure.
        const due = dueDateForPosition(this.state.x, this.state.z, this.profile, this.now())
        this.onReschedule?.(pageId, due)
        break
      }

      default:
        break
    }
    this.refreshTarget()
  }

  private advanceTend(dt: number): void {
    if (!this.tendingPage) return
    this.tendTimer += dt
    if (this.tendTimer < TEND_SECONDS) return

    const pageId = this.tendingPage
    this.tendingPage = null
    this.tendTimer = 0
    this.onTend?.(pageId)
  }

  private refreshTarget(): void {
    this.target = this.profile
      ? nearestInteractable(this.state, this.snapshot, this.profile, this.now())
      : null

    const action = actionFor(this.target, this.carrying)
    const title = this.target ? (this.titleFor?.(this.target.pageId) ?? '') : ''
    const prompt = promptFor(action, title)

    if (action !== this.action || prompt !== this.prompt) {
      this.action = action
      this.prompt = prompt
      this.onPromptChange?.(prompt, action)
    }
  }
}
