import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreateDatabase, AddProperty, AddRow, SetPropertyValue } from '@/state/databaseCommands'
import {
  seasonProgress, seasonBlend, summariseSeason, keepsakeLines, CROSSFADE_FRACTION,
} from './seasons'
import { Color } from 'three'
import { SEASONS, blendSeasons, seasonAt } from '@/render/palette'
import { SEASON_LENGTH_DAYS } from '@/core/config'

const MS_PER_DAY = 86_400_000
const NOW = Date.UTC(2026, 5, 1, 9)

function workspaceAgedDays(days: number): WorkspaceState {
  const state = createWorkspace('seasons', NOW)
  return produce(state, (draft) => {
    draft.meta.seasonStartedAt = NOW - days * MS_PER_DAY
    draft.meta.onboarded = true
  })
}

describe('seasonProgress', () => {
  it('starts at zero', () => {
    const progress = seasonProgress(workspaceAgedDays(0), NOW)
    expect(progress.progress).toBe(0)
    expect(progress.harvestReady).toBe(false)
  })

  it('reaches one at the season length', () => {
    const progress = seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS), NOW)
    expect(progress.progress).toBe(1)
    expect(progress.harvestReady).toBe(true)
  })

  it('stays ready rather than rolling over on its own', () => {
    // A local-first app may not be running when a season ends, so the festival
    // waits for you instead of having silently happened.
    const progress = seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS * 5), NOW)
    expect(progress.harvestReady).toBe(true)
    expect(progress.progress).toBe(1)
  })

  it('never reports a negative age from a clock that moved backwards', () => {
    const future = workspaceAgedDays(-10)
    const progress = seasonProgress(future, NOW)
    expect(progress.daysElapsed).toBe(0)
    expect(progress.progress).toBe(0)
  })

  it('falls back to createdAt for a workspace with no season start', () => {
    const state = produce(createWorkspace('old', NOW), (draft) => {
      // A v3 workspace migrated forward has createdAt but nothing else.
      ;(draft.meta as { seasonStartedAt: number }).seasonStartedAt = 0
    })
    expect(() => seasonProgress(state, NOW)).not.toThrow()
    expect(seasonProgress(state, NOW).daysElapsed).toBe(0)
  })
})

describe('the cross-fade', () => {
  it('does not begin until near the end of the season', () => {
    for (const fraction of [0, 0.25, 0.5, 0.7]) {
      const progress = seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS * fraction), NOW)
      expect(seasonBlend(progress).t).toBe(0)
    }
  })

  it('is complete by the season boundary', () => {
    const progress = seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS), NOW)
    expect(seasonBlend(progress).t).toBe(1)
  })

  it('runs monotonically across the fade', () => {
    let previous = -1
    for (let i = 0; i <= 20; i++) {
      const fraction = 1 - CROSSFADE_FRACTION + (CROSSFADE_FRACTION * i) / 20
      const progress = seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS * fraction), NOW)
      const t = seasonBlend(progress).t
      expect(t).toBeGreaterThanOrEqual(previous)
      previous = t
    }
  })

  it('has no visible start or end', () => {
    // Smoothstep: the derivative is zero at both ends, so the fade does not
    // announce itself by beginning suddenly.
    const at = (fraction: number) =>
      seasonBlend(seasonProgress(workspaceAgedDays(SEASON_LENGTH_DAYS * fraction), NOW)).t
    const start = 1 - CROSSFADE_FRACTION
    const justIn = at(start + CROSSFADE_FRACTION * 0.05)
    const middle = at(start + CROSSFADE_FRACTION * 0.5)
    expect(justIn).toBeLessThan(0.05)
    expect(middle).toBeCloseTo(0.5, 1)
  })

  it('fades toward the next season and wraps at the end', () => {
    const last = produce(workspaceAgedDays(SEASON_LENGTH_DAYS), (draft) => {
      draft.meta.seasonIndex = SEASONS.length - 1
    })
    const blend = seasonBlend(seasonProgress(last, NOW))
    expect(blend.from).toBe(SEASONS.length - 1)
    expect(blend.to).toBe(0)
  })

  it('handles a negative season index', () => {
    const odd = produce(workspaceAgedDays(1), (draft) => { draft.meta.seasonIndex = -3 })
    const blend = seasonBlend(seasonProgress(odd, NOW))
    expect(blend.from).toBeGreaterThanOrEqual(0)
    expect(blend.from).toBeLessThan(SEASONS.length)
  })
})

describe('blendSeasons', () => {
  it('returns the endpoints exactly', () => {
    expect(blendSeasons(0, 1, 0)).toBe(seasonAt(0))
    expect(blendSeasons(0, 1, 1)).toBe(seasonAt(1))
  })

  it('produces a colour between the two', () => {
    const a = seasonAt(0)
    const b = seasonAt(1)
    const mid = blendSeasons(0, 1, 0.5)
    const between = (x: number, p: number, q: number) =>
      x >= Math.min(p, q) - 1e-6 && x <= Math.max(p, q) + 1e-6
    expect(between(mid.water.r, a.water.r, b.water.r)).toBe(true)
    expect(between(mid.water.g, a.water.g, b.water.g)).toBe(true)
    expect(between(mid.skyTop.b, a.skyTop.b, b.skyTop.b)).toBe(true)
  })

  it('blends the DOM accent too, so both halves agree', () => {
    const mid = blendSeasons(0, 1, 0.5)
    expect(mid.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(mid.accent).not.toBe(seasonAt(0).accent)
    expect(mid.accent).not.toBe(seasonAt(1).accent)
  })

  it('clamps out-of-range blends', () => {
    expect(blendSeasons(0, 1, -1)).toBe(seasonAt(0))
    expect(blendSeasons(0, 1, 5)).toBe(seasonAt(1))
  })

  it('never introduces an alarm colour', () => {
    /**
     * Section 17: no red, no alarm colours anywhere.
     *
     * Defining "red" took two wrong attempts, both instructive. Flagging
     * "red much higher than the other channels" fails on Lantern Gold's sun,
     * rgb(1.00, 0.68, 0.32) - the amber the season is named after. Flagging
     * "red high, green and blue low" then fails on that season's ambient,
     * rgb(0.47, 0.32, 0.24), which is a dark warm brown: in any dark colour
     * every channel is low, so the rule was really measuring brightness.
     *
     * An alarm colour is a matter of hue and saturation, not channel
     * arithmetic. It is red in hue, strongly saturated, and bright enough to
     * shout. Amber sits at 25-40 degrees and brown is barely saturated, so both
     * pass - correctly, because neither is an alarm.
     */
    const isAlarming = (colour: Color) => {
      const hsl = { h: 0, s: 0, l: 0 }
      colour.getHSL(hsl)
      const degrees = hsl.h * 360
      const redHue = degrees < 15 || degrees > 345
      return redHue && hsl.s > 0.5 && hsl.l > 0.3
    }

    for (let from = 0; from < SEASONS.length; from++) {
      for (let i = 0; i <= 10; i++) {
        const p = blendSeasons(from, from + 1, i / 10)
        for (const colour of [p.water, p.waterDeep, p.skyTop, p.skyHorizon, p.sun, p.ambient, p.foam, p.outline]) {
          expect(isAlarming(colour), `${p.id} at ${i / 10}`).toBe(false)
        }
      }
    }
  })

  it('never overshoots either endpoint', () => {
    // The real risk from blending is not inventing a colour but exaggerating
    // one: an interpolation that leaves the segment between two palettes could
    // push a warm sun past anything either season actually contains.
    for (let from = 0; from < SEASONS.length; from++) {
      const a = seasonAt(from)
      const b = seasonAt(from + 1)
      for (let i = 0; i <= 10; i++) {
        const p = blendSeasons(from, from + 1, i / 10)
        for (const key of ['water', 'waterDeep', 'skyTop', 'skyHorizon', 'sun', 'ambient'] as const) {
          for (const ch of ['r', 'g', 'b'] as const) {
            const low = Math.min(a[key][ch], b[key][ch])
            const high = Math.max(a[key][ch], b[key][ch])
            expect(p[key][ch]).toBeGreaterThanOrEqual(low - 1e-6)
            expect(p[key][ch]).toBeLessThanOrEqual(high + 1e-6)
          }
        }
      }
    }
  })
})

describe('summariseSeason', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let dbId: string
  let statusId: string

  const setup = (seasonStartDaysAgo: number) => {
    state = createWorkspace('harvest', NOW)
    stack = new CommandStack((m) => { state = produce(state, m) })
    const db = new CreateDatabase('Tasks')
    stack.execute(db)
    dbId = db.databaseId
    const status = new AddProperty(dbId, 'status', 'Status')
    stack.execute(status)
    statusId = status.propertyId
    state = produce(state, (draft) => {
      draft.meta.seasonStartedAt = NOW - seasonStartDaysAgo * MS_PER_DAY
    })
  }

  const complete = (rowId: string, at: number) => {
    const option = state.databases[dbId].properties
      .find((p) => p.id === statusId)!.options!.find((o) => o.group === 'complete')!
    stack.execute(new SetPropertyValue(rowId, statusId, option.id))
    state = produce(state, (draft) => { draft.pages[rowId].updatedAt = at })
  }

  const addRow = (title: string) => {
    const row = new AddRow(dbId)
    stack.execute(row)
    state = produce(state, (draft) => { draft.pages[row.rowId].title = title })
    return row.rowId
  }

  it('names what was tended this season', () => {
    setup(10)
    complete(addRow('Two Sum'), NOW - 3 * MS_PER_DAY)
    complete(addRow('LRU Cache'), NOW - 1 * MS_PER_DAY)
    addRow('Word Ladder')

    const summary = summariseSeason(state, NOW)
    expect(summary.tended).toEqual(['LRU Cache', 'Two Sum'])
    expect(summary.stillGrowing).toBe(1)
  })

  it('leaves out work finished before this season began', () => {
    setup(10)
    complete(addRow('Ancient History'), NOW - 40 * MS_PER_DAY)
    const summary = summariseSeason(state, NOW)
    expect(summary.tended).toEqual([])
  })

  it('counts the season number from the harvests held', () => {
    setup(10)
    state = produce(state, (draft) => { draft.meta.seasonsHarvested = 3 })
    expect(summariseSeason(state, NOW).seasonNumber).toBe(4)
  })

  it('uses the same reading of "done" as the island', () => {
    // A keepsake that disagrees with the lanterns burning on the hill would be
    // the tool contradicting itself.
    setup(10)
    const row = addRow('Half Done')
    const inProgress = state.databases[dbId].properties
      .find((p) => p.id === statusId)!.options!.find((o) => o.group === 'inProgress')!
    stack.execute(new SetPropertyValue(row, statusId, inProgress.id))

    const summary = summariseSeason(state, NOW)
    expect(summary.tended).toEqual([])
    expect(summary.stillGrowing).toBe(1)
  })
})

describe('keepsakeLines', () => {
  const base = {
    seasonNumber: 1, lanternsLit: 0, focusMinutes: 0,
    stillGrowing: 0, startedAt: NOW - 14 * MS_PER_DAY, endedAt: NOW,
  }

  it('reads warmly when nothing was finished', () => {
    // Guarantee 1: there is no failed harvest, and the page must not read as
    // though there were.
    const text = keepsakeLines({ ...base, tended: [] }, 'Thornwick').join(' ')
    expect(text).toContain('quiet season')
    expect(text).not.toMatch(/fail|missed|behind|nothing done|only/i)
    expect(text).toContain('still here')
  })

  it('names one, two and a few', () => {
    const one = keepsakeLines({ ...base, tended: ['Two Sum'] }, 'Isle').join(' ')
    expect(one).toContain('You tended Two Sum.')

    const two = keepsakeLines({ ...base, tended: ['A', 'B'] }, 'Isle').join(' ')
    expect(two).toContain('You tended A and B.')

    const few = keepsakeLines({ ...base, tended: ['A', 'B', 'C'] }, 'Isle').join(' ')
    expect(few).toContain('You tended A, B and C.')
  })

  it('names the first two and counts the rest', () => {
    // "You completed 14 tasks" is a report; naming them is a memory.
    const many = keepsakeLines(
      { ...base, tended: ['A', 'B', 'C', 'D', 'E', 'F'] }, 'Isle',
    ).join(' ')
    expect(many).toContain('A, B and 4 others')
  })

  it('mentions focus only when there was some', () => {
    const none = keepsakeLines({ ...base, tended: [] }, 'Isle').join(' ')
    expect(none).not.toMatch(/focus/i)

    const some = keepsakeLines({ ...base, focusMinutes: 150, tended: [] }, 'Isle').join(' ')
    expect(some).toContain('2.5 hours')
  })

  it('says carried-over work is not lost', () => {
    const text = keepsakeLines({ ...base, tended: [], stillGrowing: 5 }, 'Isle').join(' ')
    expect(text).toContain('carry over')
    expect(text).toContain('nothing is lost')
  })

  it('falls back gracefully with no isle name', () => {
    expect(keepsakeLines({ ...base, tended: [] }, '').join(' ')).toContain('the isle')
  })

  it('never scores or grades', () => {
    const text = keepsakeLines(
      { ...base, tended: ['A', 'B'], focusMinutes: 200, stillGrowing: 3 }, 'Isle',
    ).join(' ')
    expect(text).not.toMatch(/score|rank|streak|%|per cent|better than|worse/i)
  })
})
