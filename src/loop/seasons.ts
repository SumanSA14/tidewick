import { SEASON_LENGTH_DAYS } from '@/core/config'
import { SEASONS } from '@/render/palette'
import type { WorkspaceState } from '@/state/types'
import { isPageComplete, countLanterns } from '@/island/derive'

/**
 * Seasons and the Harvest Festival.
 *
 * A season is a work cycle, not a calendar month: it starts when the last one
 * ended and closes with a celebration and a keepsake page. Section 5 step 6.
 *
 * Everything here is a pure function of the workspace and a clock, so "is it
 * harvest time" is answerable without any scheduled job, timer or background
 * task. That matters for a local-first app that may not be running when a
 * season technically ends - the festival is waiting when you next open it,
 * rather than having silently happened while the laptop was shut.
 */

const MS_PER_DAY = 86_400_000

export interface SeasonProgress {
  index: number
  /** 0..1 through the current season. */
  progress: number
  daysElapsed: number
  daysRemaining: number
  /** True once the season is over and the festival has not yet been held. */
  harvestReady: boolean
}

export function seasonProgress(
  state: WorkspaceState,
  now: number,
  lengthDays = SEASON_LENGTH_DAYS,
): SeasonProgress {
  const startedAt = state.meta.seasonStartedAt || state.meta.createdAt || now
  const daysElapsed = Math.max(0, (now - startedAt) / MS_PER_DAY)
  const progress = Math.min(1, daysElapsed / lengthDays)
  return {
    index: state.meta.seasonIndex,
    progress,
    daysElapsed,
    daysRemaining: Math.max(0, lengthDays - daysElapsed),
    harvestReady: daysElapsed >= lengthDays,
  }
}

/**
 * The blend between this season's palette and the next.
 *
 * Section 8 asks for a cross-fade rather than a switch: the isle should change
 * the way a season changes, which is to say you notice one morning that it
 * already has. The fade occupies the last stretch of the season so that by the
 * time the festival arrives the land already looks like the season it is
 * becoming.
 */
export const CROSSFADE_FRACTION = 0.22

export interface SeasonBlend {
  from: number
  to: number
  /** 0..1; zero for most of the season, easing to one at the boundary. */
  t: number
}

export function seasonBlend(progress: SeasonProgress): SeasonBlend {
  const from = ((progress.index % SEASONS.length) + SEASONS.length) % SEASONS.length
  const to = (from + 1) % SEASONS.length
  const start = 1 - CROSSFADE_FRACTION
  if (progress.progress <= start) return { from, to, t: 0 }
  const raw = (progress.progress - start) / CROSSFADE_FRACTION
  const clamped = Math.max(0, Math.min(1, raw))
  // Smoothstep, so the change has no visible start or end.
  return { from, to, t: clamped * clamped * (3 - 2 * clamped) }
}

export interface HarvestSummary {
  seasonNumber: number
  lanternsLit: number
  focusMinutes: number
  /** Tasks that became lanterns during this season. */
  tended: string[]
  /** Still growing when the season closed. Carried, never lost. */
  stillGrowing: number
  startedAt: number
  endedAt: number
}

/**
 * What the season amounted to.
 *
 * Counts only what actually happened. There is no score, no grade and no
 * comparison with the previous season, because a keepsake that ranks you is a
 * keepsake you stop wanting to read.
 */
export function summariseSeason(
  state: WorkspaceState,
  now: number,
): HarvestSummary {
  const startedAt = state.meta.seasonStartedAt || state.meta.createdAt || now
  const tended: string[] = []
  let stillGrowing = 0

  for (const page of Object.values(state.pages)) {
    if (page.trashed || !page.databaseId) continue
    const database = state.databases[page.databaseId]
    if (!database) continue

    if (isPageComplete(state, page.id)) {
      // Completed within this season: `updatedAt` is the closest thing to a
      // completion time without storing a second timestamp per row, and a
      // dedicated one would be workspace state existing only for the game.
      if (page.updatedAt >= startedAt) tended.push(page.title || 'Untitled')
    } else {
      stillGrowing++
    }
  }

  return {
    seasonNumber: state.meta.seasonsHarvested + 1,
    // Derived from the pages, not read off the counter: see countLanterns.
    lanternsLit: countLanterns(state),
    focusMinutes: Math.round(state.meta.focusMinutes),
    tended: tended.sort(),
    stillGrowing,
    startedAt,
    endedAt: now,
  }
}

/**
 * The keepsake, as markdown-ish lines for a new page.
 *
 * Warm, specific and short. It names what was tended rather than counting it,
 * because "you completed 14 tasks" is a report and "Two Sum, LRU Cache, and
 * twelve others" is a memory.
 */
export function keepsakeLines(summary: HarvestSummary, isleName: string): string[] {
  const lines: string[] = []
  const island = isleName || 'the isle'
  const span = Math.max(1, Math.round((summary.endedAt - summary.startedAt) / MS_PER_DAY))

  lines.push(`${span} days on ${island}.`)

  if (summary.tended.length === 0) {
    // A season with nothing finished is still a season. Guarantee 1: there is
    // no failed harvest, and the page must not read like one.
    lines.push('A quiet season. The isle kept growing anyway, and everything you planted is still here.')
  } else {
    lines.push(named(summary.tended))
  }

  if (summary.focusMinutes > 0) {
    const hours = summary.focusMinutes / 60
    lines.push(
      hours >= 1
        ? `${hours.toFixed(1)} hours of measured focus, which is where every lantern on the hill came from.`
        : `${summary.focusMinutes} minutes of measured focus.`,
    )
  }

  if (summary.stillGrowing > 0) {
    lines.push(
      `${summary.stillGrowing} still growing. They carry over - nothing is lost at the turn of a season.`,
    )
  }

  lines.push('The lanterns stay lit.')
  return lines
}

/** "Two Sum, LRU Cache and twelve others." */
function named(titles: string[]): string {
  if (titles.length === 1) return `You tended ${titles[0]}.`
  if (titles.length === 2) return `You tended ${titles[0]} and ${titles[1]}.`
  if (titles.length <= 4) {
    return `You tended ${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}.`
  }
  const rest = titles.length - 2
  return `You tended ${titles[0]}, ${titles[1]} and ${rest} others.`
}
