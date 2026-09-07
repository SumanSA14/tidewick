import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreateDatabase, AddRow, AddProperty, SetPropertyValue, DeleteRow } from '@/state/databaseCommands'
import { CreatePage } from '@/state/blockCommands'
import { BankFocus, LightLantern, HoldHarvest, harvestFor } from './loopCommands'
import {
  accrue, stepWarmth, spendOnBloom, decayFor, applyFocus,
  WARMTH, DECAY_FLOOR, DECAY_OVER_DAYS, BLOOM_COST,
} from './economy'
import { createSession, start, tickSession, stop } from './focus'
import { summariseSeason, keepsakeLines, seasonProgress } from './seasons'
import { tendCommand } from '@/keeper/commands'

/**
 * The six cozy guarantees (Section 3.6).
 *
 * The brief asks for these to be "enforced and unit-tested", and it is right to
 * ask twice: a comment saying "no fail state" is worth nothing the day someone
 * adds a plausible-looking penalty branch. Each guarantee below is written as
 * the adversarial version of itself - the test tries to find the fail state,
 * tries to farm the currency, tries to make deletion cost something - and
 * passes only when it cannot.
 */

const MS_PER_DAY = 86_400_000
const NOW = Date.UTC(2026, 5, 1, 9)

let state: WorkspaceState
let stack: CommandStack
let dbId: string
let statusId: string

const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }

beforeEach(() => {
  state = createWorkspace('cozy', NOW)
  stack = new CommandStack(run)

  const db = new CreateDatabase('Tasks')
  stack.execute(db)
  dbId = db.databaseId

  const status = new AddProperty(dbId, 'status', 'Status')
  stack.execute(status)
  statusId = status.propertyId
})

const addRow = () => {
  const row = new AddRow(dbId)
  stack.execute(row)
  return row.rowId
}

describe('1 — no fail state', () => {
  it('never lets Sunlight go negative, however much is spent', () => {
    for (let i = 0; i < 200; i++) stack.execute(new LightLantern())
    expect(state.meta.sunlight).toBe(0)
    expect(state.meta.sunlight).toBeGreaterThanOrEqual(0)
  })

  it('lets a task complete with an empty reserve', () => {
    // Gating real work behind a resource would be a fail state wearing a
    // friendly hat.
    expect(state.meta.sunlight).toBe(0)
    const row = addRow()
    const command = tendCommand(state, row)
    expect(command).not.toBeNull()
    stack.execute(command!)
    stack.execute(new LightLantern())

    const complete = state.databases[dbId].properties
      .find((p) => p.id === statusId)!.options!.find((o) => o.group === 'complete')!
    expect(state.pages[row].properties?.[statusId]).toBe(complete.id)
    expect(state.meta.lanternsLit).toBe(1)
  })

  it('has no reachable state where warmth is zero', () => {
    let warmth: number = WARMTH.base
    // A month of pure distraction.
    for (let i = 0; i < 60 * 24 * 30; i++) warmth = stepWarmth(warmth, 60, false)
    expect(warmth).toBe(WARMTH.min)
    expect(warmth).toBeGreaterThan(0)
  })

  it('keeps everything earned when a session is stopped early', () => {
    let session = start(createSession(25, NOW), NOW)
    for (let i = 0; i < 10 * 60; i++) {
      session = tickSession(session, { windowFocused: true, activity: true }, 1)
    }
    const earned = session.earned
    expect(earned).toBeGreaterThan(0)

    session = stop(session)
    // Stopping at ten minutes is not a failure and must not cost anything.
    expect(session.earned).toBe(earned)
    expect(session.focusedSeconds).toBeGreaterThan(0)
  })
})

describe('2 — all decay is capped and reversible', () => {
  it('never decays past the floor, however long the absence', () => {
    for (const days of [1, 7, 21, 90, 365, 3650]) {
      const warmth = decayFor(NOW, NOW + days * MS_PER_DAY)
      expect(warmth).toBeGreaterThanOrEqual(DECAY_FLOOR)
      expect(warmth).toBeLessThanOrEqual(1)
    }
  })

  it('makes three weeks away a quiet island, not a dead one', () => {
    const warmth = decayFor(NOW, NOW + DECAY_OVER_DAYS * MS_PER_DAY)
    expect(warmth).toBeCloseTo(DECAY_FLOOR, 5)
    // "A quiet, overgrown island you are glad to come back to" - so more than
    // half its warmth has to survive.
    expect(warmth).toBeGreaterThan(0.5)
  })

  it('barely registers a weekend', () => {
    expect(decayFor(NOW, NOW + 2 * MS_PER_DAY)).toBeGreaterThan(0.98)
  })

  it('is fully reversible: coming back resets it', () => {
    const away = decayFor(NOW, NOW + 100 * MS_PER_DAY)
    expect(away).toBe(DECAY_FLOOR)
    // decayFor is a function of "since last opened", so one visit restores it.
    const returned = decayFor(NOW + 100 * MS_PER_DAY, NOW + 100 * MS_PER_DAY)
    expect(returned).toBe(1)
  })

  it('destroys no data at a season boundary', () => {
    const row = addRow()
    stack.execute(new BankFocus(600, 12, 1.2))
    const sunlightBefore = state.meta.sunlight
    const lanternsBefore = state.meta.lanternsLit

    stack.execute(harvestFor(state, NOW + 20 * MS_PER_DAY))

    expect(state.pages[row]).toBeDefined()
    expect(state.meta.sunlight).toBe(sunlightBefore)
    expect(state.meta.lanternsLit).toBe(lanternsBefore)
  })
})

describe('3 — nothing may delete, hide or corrupt real data', () => {
  it('leaves pages, blocks and databases untouched when focus is banked', () => {
    const row = addRow()
    stack.execute(new SetPropertyValue(row, statusId, 'anything'))
    const before = {
      pages: JSON.stringify(state.pages),
      blocks: JSON.stringify(state.blocks),
      databases: JSON.stringify(state.databases),
    }

    stack.execute(new BankFocus(1500, 30, 1.4))
    stack.execute(new LightLantern())

    expect(JSON.stringify(state.pages)).toBe(before.pages)
    expect(JSON.stringify(state.blocks)).toBe(before.blocks)
    expect(JSON.stringify(state.databases)).toBe(before.databases)
  })

  it('only adds a page at harvest, never removes one', () => {
    const rows = [addRow(), addRow(), addRow()]
    const pagesBefore = Object.keys(state.pages).length

    stack.execute(harvestFor(state, NOW + 20 * MS_PER_DAY))

    expect(Object.keys(state.pages).length).toBe(pagesBefore + 1)
    for (const row of rows) expect(state.pages[row]).toBeDefined()
  })

  it('makes the keepsake an ordinary, editable page', () => {
    // A page the user cannot touch is not a keepsake, it is a trophy.
    const harvest = harvestFor(state, NOW + 20 * MS_PER_DAY)
    stack.execute(harvest)
    const page = state.pages[harvest.pageId]
    expect(page.trashed).toBeUndefined()
    expect(page.children.length).toBeGreaterThan(0)
    expect(state.pageOrder).toContain(harvest.pageId)
  })

  it('undoes a harvest cleanly, leaving nothing behind', () => {
    const harvest = harvestFor(state, NOW + 20 * MS_PER_DAY)
    const blocksBefore = Object.keys(state.blocks).length
    stack.execute(harvest)
    stack.undo()

    expect(state.pages[harvest.pageId]).toBeUndefined()
    expect(Object.keys(state.blocks).length).toBe(blocksBefore)
    expect(state.pageOrder).not.toContain(harvest.pageId)
    expect(state.meta.seasonsHarvested).toBe(0)
  })
})

describe('4 — never reward task creation', () => {
  it('grants nothing for creating rows', () => {
    const before = state.meta.sunlight
    for (let i = 0; i < 50; i++) addRow()
    expect(state.meta.sunlight).toBe(before)
    expect(state.meta.focusMinutes).toBe(0)
  })

  it('grants nothing for creating pages, editing or browsing', () => {
    const before = state.meta.sunlight
    for (let i = 0; i < 20; i++) {
      const page = new CreatePage()
      stack.execute(page)
    }
    const row = addRow()
    for (let i = 0; i < 20; i++) {
      stack.execute(new SetPropertyValue(row, statusId, `v${i}`))
    }
    expect(state.meta.sunlight).toBe(before)
  })

  it('accrues from measured focus and from nothing else', () => {
    // The accrual function takes exactly one quantity that can raise it.
    expect(accrue(0, WARMTH.max)).toBe(0)
    expect(accrue(-100, WARMTH.max)).toBe(0)
    expect(accrue(60, WARMTH.base)).toBeGreaterThan(0)
    expect(accrue(120, WARMTH.base)).toBeCloseTo(2 * accrue(60, WARMTH.base), 6)
  })
})

describe('5 — deleting a task is neutral', () => {
  it('costs nothing to delete a row', () => {
    const rows = [addRow(), addRow(), addRow()]
    stack.execute(new BankFocus(1500, 25, 1.3))
    const sunlight = state.meta.sunlight
    const lanterns = state.meta.lanternsLit

    for (const row of rows) stack.execute(new DeleteRow(dbId, row))

    // Dropping something is often the correct decision.
    expect(state.meta.sunlight).toBe(sunlight)
    expect(state.meta.lanternsLit).toBe(lanterns)
  })

  it('never decreases the lantern count', () => {
    const row = addRow()
    stack.execute(new LightLantern())
    expect(state.meta.lanternsLit).toBe(1)

    stack.execute(new DeleteRow(dbId, row))
    // The work was really done. Deleting the record of it does not undo that.
    expect(state.meta.lanternsLit).toBe(1)
  })

  it('does not count a deleted task against the harvest', () => {
    const row = addRow()
    stack.execute(new DeleteRow(dbId, row))
    const summary = summariseSeason(state, NOW + 20 * MS_PER_DAY)
    expect(summary.stillGrowing).toBe(0)
    expect(keepsakeLines(summary, 'Isle').join(' ')).not.toContain('behind')
  })
})

describe('6 — no purchasable, grindable or clickable currency', () => {
  it('cannot be farmed by clicking', () => {
    const before = state.meta.sunlight
    // Every command a user could bind to a key, many times over. Two hundred
    // proves the point as well as two thousand and does not spend eight
    // seconds of the suite's budget doing it.
    for (let i = 0; i < 200; i++) {
      stack.execute(new SetPropertyValue(addRow(), statusId, 'x'))
    }
    expect(state.meta.sunlight).toBe(before)
    expect(state.meta.focusMinutes).toBe(0)
    expect(state.meta.warmth).toBe(1)
  })

  it('cannot exceed one unit per minute times the warmth ceiling', () => {
    // The hard cap on the economy: there is no multiplier stacking, no combo
    // and no bonus, so an hour of perfect focus has an exact upper bound.
    const hour = accrue(3600, WARMTH.max)
    expect(hour).toBeCloseTo(60 * WARMTH.max, 6)
    expect(hour).toBeLessThanOrEqual(60 * WARMTH.max)
  })

  it('has no conversion from lanterns back into Sunlight', () => {
    stack.execute(new BankFocus(600, 10, 1))
    const sunlight = state.meta.sunlight
    for (let i = 0; i < 20; i++) stack.execute(new LightLantern())
    // Spending only ever goes one way.
    expect(state.meta.sunlight).toBeLessThanOrEqual(sunlight)
  })

  it('pays a distracted hour less than a focused one, but never zero', () => {
    let focused: number = WARMTH.base
    let distracted: number = WARMTH.base
    let focusedEarned = 0
    let distractedEarned = 0

    for (let minute = 0; minute < 60; minute++) {
      focused = stepWarmth(focused, 60, true)
      focusedEarned += accrue(60, focused)
      // Half attention: alternate minutes.
      const attending = minute % 2 === 0
      distracted = stepWarmth(distracted, 60, attending)
      if (attending) distractedEarned += accrue(60, distracted)
    }

    expect(distractedEarned).toBeGreaterThan(0)
    expect(distractedEarned).toBeLessThan(focusedEarned)
  })
})

describe('the guarantees hold together', () => {
  it('leaves a three-week absence with a recoverable island', () => {
    // The Phase 7 acceptance criterion, end to end.
    const row = addRow()
    stack.execute(new BankFocus(1500, 25, 1.3))
    const away = NOW + 21 * MS_PER_DAY

    expect(state.pages[row]).toBeDefined()
    expect(state.meta.sunlight).toBeGreaterThan(0)
    expect(decayFor(NOW, away)).toBeGreaterThanOrEqual(DECAY_FLOOR)

    const progress = seasonProgress(state, away)
    expect(progress.harvestReady).toBe(true)
    // And the festival is waiting rather than having silently happened.
    expect(state.meta.seasonsHarvested).toBe(0)
  })

  it('spends at most the bloom cost per completion', () => {
    stack.execute(new BankFocus(6000, 100, 1.5))
    const before = state.meta.sunlight
    stack.execute(new LightLantern())
    expect(before - state.meta.sunlight).toBeCloseTo(BLOOM_COST, 6)
  })

  it('never charges more than is there', () => {
    const { spent, left } = spendOnBloom(0.5, BLOOM_COST)
    expect(spent).toBe(0.5)
    expect(left).toBe(0)
  })

  it('keeps applyFocus from paying for unfocused time', () => {
    const meta = { sunlight: 0, focusMinutes: 0, lanternsLit: 0, warmth: WARMTH.base }
    const drifted = applyFocus(meta, 600, false)
    expect(drifted.sunlight).toBe(0)
    expect(drifted.focusMinutes).toBe(0)
    expect(drifted.warmth).toBeLessThan(WARMTH.base)
  })
})

describe('undo restores the economy exactly', () => {
  it('rolls a banked session back', () => {
    stack.execute(new BankFocus(1500, 25, 1.4))
    expect(state.meta.sunlight).toBe(25)
    stack.undo()
    expect(state.meta.sunlight).toBe(0)
    expect(state.meta.focusMinutes).toBe(0)
    expect(state.meta.warmth).toBe(1)
  })

  it('rolls a lantern back', () => {
    stack.execute(new BankFocus(1500, 25, 1))
    stack.execute(new LightLantern())
    expect(state.meta.lanternsLit).toBe(1)
    stack.undo()
    expect(state.meta.lanternsLit).toBe(0)
    expect(state.meta.sunlight).toBe(25)
  })

  it('survives redo', () => {
    stack.execute(new BankFocus(1500, 25, 1.2))
    stack.undo()
    stack.redo()
    expect(state.meta.sunlight).toBe(25)
  })
})

describe('HoldHarvest', () => {
  it('advances the season and starts the next', () => {
    stack.execute(harvestFor(state, NOW + 20 * MS_PER_DAY))
    expect(state.meta.seasonIndex).toBe(1)
    expect(state.meta.seasonsHarvested).toBe(1)
    expect(state.meta.seasonStartedAt).toBe(NOW + 20 * MS_PER_DAY)
    expect(seasonProgress(state, NOW + 20 * MS_PER_DAY).harvestReady).toBe(false)
  })

  it('writes a keepsake that reads warmly on an empty season', () => {
    const harvest = harvestFor(state, NOW + 20 * MS_PER_DAY)
    stack.execute(harvest)
    const text = state.pages[harvest.pageId].children
      .map((id) => state.blocks[id].text)
      .join(' ')
    expect(text).toContain('quiet season')
    expect(text).not.toMatch(/fail|missed|behind|only|0 tasks/i)
  })

  it('is stable when re-applied, so redo does not duplicate blocks', () => {
    const harvest = new HoldHarvest(
      summariseSeason(state, NOW + 20 * MS_PER_DAY), 'Isle', NOW + 20 * MS_PER_DAY,
    )
    stack.execute(harvest)
    const first = state.pages[harvest.pageId].children.length
    stack.undo()
    stack.redo()
    expect(state.pages[harvest.pageId].children.length).toBe(first)
  })
})
