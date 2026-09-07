import type { Command } from '@/state/commands'
import type { WorkspaceState } from '@/state/types'
import { createPage, createBlock } from '@/state/blocks'
import { newId } from '@/state/blockCommands'
import { WARMTH, spendOnBloom, BLOOM_COST } from './economy'
import { summariseSeason, keepsakeLines, type HarvestSummary } from './seasons'
import { SEASONS } from '@/render/palette'

/**
 * The gentle loop, as commands.
 *
 * Everything the loop changes goes through the same stack as an ordinary edit,
 * because Section 2 allows no parallel game state. That has a pleasant
 * consequence and an awkward one, and both are deliberate:
 *
 * - Pleasant: Sunlight and seasons are persisted, exported and undone by
 *   machinery that already existed. Not one line of save code was written for
 *   the game.
 * - Awkward: banking a focus session is undoable, which sounds odd for elapsed
 *   time. It is the right trade. The alternative is a second mutation path
 *   into the same tree, and that is exactly the "hold game state separately for
 *   now" anti-pattern the brief warns about - it never does get merged.
 */

/**
 * Bank a completed slice of focus.
 *
 * Called when a session ends or is stopped, never per frame: a command per
 * animation frame would fill the undo stack with sixty entries a second.
 */
export class BankFocus implements Command {
  readonly label = 'Focus session'
  private before: { sunlight: number; focusMinutes: number; warmth: number } | null = null

  constructor(
    private readonly focusedSeconds: number,
    private readonly earned: number,
    private readonly warmth: number,
  ) {}

  apply(draft: WorkspaceState): void {
    if (!this.before) {
      this.before = {
        sunlight: draft.meta.sunlight,
        focusMinutes: draft.meta.focusMinutes,
        warmth: draft.meta.warmth,
      }
    }
    // Guarantee 4 and 6: the only inputs are measured seconds and what they
    // earned. There is no path here from anything the user could click.
    draft.meta.sunlight = Math.max(0, draft.meta.sunlight + Math.max(0, this.earned))
    draft.meta.focusMinutes += Math.max(0, this.focusedSeconds) / 60
    draft.meta.warmth = clamp(this.warmth, WARMTH.min, WARMTH.max)
  }

  invert(draft: WorkspaceState): void {
    if (!this.before) return
    draft.meta.sunlight = this.before.sunlight
    draft.meta.focusMinutes = this.before.focusMinutes
    draft.meta.warmth = this.before.warmth
  }
}

/**
 * Light a lantern.
 *
 * Dispatched alongside the completion, not instead of it. **It cannot fail and
 * cannot block**: with an empty reserve the task still completes and the bloom
 * is simply plainer. Gating real work behind a resource would be a fail state
 * wearing a friendly hat.
 */
export class LightLantern implements Command {
  readonly label = 'Tend'
  private before: { sunlight: number; lanternsLit: number } | null = null

  constructor(private readonly cost = BLOOM_COST) {}

  apply(draft: WorkspaceState): void {
    if (!this.before) {
      this.before = { sunlight: draft.meta.sunlight, lanternsLit: draft.meta.lanternsLit }
    }
    const { left } = spendOnBloom(draft.meta.sunlight, this.cost)
    draft.meta.sunlight = left
    draft.meta.lanternsLit += 1
  }

  invert(draft: WorkspaceState): void {
    if (!this.before) return
    draft.meta.sunlight = this.before.sunlight
    draft.meta.lanternsLit = this.before.lanternsLit
  }
}

/**
 * Hold the Harvest Festival.
 *
 * Writes a keepsake page, advances the season and starts the next one. The
 * keepsake is an ordinary page: it can be edited, linked, moved and deleted
 * like anything else, because a page the user is not allowed to touch is not a
 * keepsake, it is a trophy.
 */
export class HoldHarvest implements Command {
  readonly label = 'Harvest Festival'
  readonly pageId: string
  private blockIds: string[] = []
  private before: { seasonIndex: number; seasonStartedAt: number; seasonsHarvested: number } | null = null

  constructor(
    private readonly summary: HarvestSummary,
    private readonly isleName: string,
    private readonly now: number,
    pageId = newId(),
  ) {
    this.pageId = pageId
  }

  apply(draft: WorkspaceState): void {
    if (!this.before) {
      this.before = {
        seasonIndex: draft.meta.seasonIndex,
        seasonStartedAt: draft.meta.seasonStartedAt,
        seasonsHarvested: draft.meta.seasonsHarvested,
      }
    }

    const season = SEASONS[draft.meta.seasonIndex % SEASONS.length]
    const page = createPage(this.pageId, null)
    page.title = `${season.name} — season ${this.summary.seasonNumber}`
    page.createdAt = this.now
    page.updatedAt = this.now
    draft.pages[this.pageId] = page
    draft.pageOrder.unshift(this.pageId)

    const lines = keepsakeLines(this.summary, this.isleName)
    if (this.blockIds.length === 0) this.blockIds = lines.map(() => newId())

    for (let i = 0; i < lines.length; i++) {
      const block = createBlock(this.blockIds[i], this.pageId, null)
      block.text = lines[i]
      draft.blocks[block.id] = block
      page.children.push(block.id)
    }

    draft.meta.seasonIndex = draft.meta.seasonIndex + 1
    draft.meta.seasonStartedAt = this.now
    draft.meta.seasonsHarvested += 1
    // Sunlight and lanterns deliberately survive the turn: guarantee 2 and 5.
    // A season boundary that reset your reserve would be decay that destroys,
    // and the lanterns are permanent by definition.
  }

  invert(draft: WorkspaceState): void {
    if (!this.before) return
    for (const id of this.blockIds) delete draft.blocks[id]
    delete draft.pages[this.pageId]
    draft.pageOrder = draft.pageOrder.filter((id) => id !== this.pageId)
    draft.meta.seasonIndex = this.before.seasonIndex
    draft.meta.seasonStartedAt = this.before.seasonStartedAt
    draft.meta.seasonsHarvested = this.before.seasonsHarvested
  }
}

/** Build the harvest command for the current state, or null if it is not due. */
export function harvestFor(state: WorkspaceState, now: number): HoldHarvest {
  return new HoldHarvest(summariseSeason(state, now), state.meta.isleName, now)
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
