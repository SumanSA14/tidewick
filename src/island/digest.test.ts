import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreateDatabase, AddProperty, AddRow, SetPropertyValue, DeleteRow } from '@/state/databaseCommands'
import { CreatePage } from '@/state/blockCommands'
import { islandDigest } from './derive'

/**
 * The home page's numbers are counted, not stored.
 *
 * A stored "due today" would be wrong by midnight; a stored "in the shallows"
 * would be wrong the moment a row was rescheduled while the page was showing.
 * Everything in the digest is a function of the workspace and a clock.
 */
describe('islandDigest', () => {
  // A fixed local noon, so "today" is unambiguous whatever zone the test runs in.
  const NOW = new Date(2026, 5, 14, 12).getTime()
  const iso = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  let state: WorkspaceState
  let stack: CommandStack
  let dbId: string
  let statusId: string
  let dueId: string
  let completeId: string

  beforeEach(() => {
    state = createWorkspace('digest', NOW)
    stack = new CommandStack((m) => { state = produce(state, m) })
    const db = new CreateDatabase('Tasks')
    stack.execute(db)
    dbId = db.databaseId
    const status = new AddProperty(dbId, 'status', 'Status')
    stack.execute(status)
    statusId = status.propertyId
    const due = new AddProperty(dbId, 'date', 'Due')
    stack.execute(due)
    dueId = due.propertyId
    completeId = state.databases[dbId].properties
      .find((p) => p.id === statusId)!.options!.find((o) => o.group === 'complete')!.id
  })

  const row = (dueDate?: string, done = false) => {
    const r = new AddRow(dbId)
    stack.execute(r)
    if (dueDate) stack.execute(new SetPropertyValue(r.rowId, dueId, { start: dueDate }))
    if (done) stack.execute(new SetPropertyValue(r.rowId, statusId, completeId))
    return r.rowId
  }

  it('is all zeros on an empty isle', () => {
    expect(islandDigest(state, NOW)).toEqual({
      dueToday: 0, inShallows: 0, growing: 0, meadow: 0, lanterns: 0, nextDue: null, regions: 0,
    })
  })

  it('sorts every unfinished task into exactly one place', () => {
    row(iso(2026, 6, 14))          // today
    row(iso(2026, 6, 10))          // overdue: shallows
    row(iso(2026, 7, 1))           // growing
    row()                          // meadow
    row(iso(2026, 6, 1), true)     // done: lantern, not counted anywhere else

    const d = islandDigest(state, NOW)
    expect(d.dueToday).toBe(1)
    expect(d.inShallows).toBe(1)
    expect(d.growing).toBe(1)
    expect(d.meadow).toBe(1)
    // The buckets are exclusive, so they add up to the unfinished work.
    expect(d.dueToday + d.inShallows + d.growing + d.meadow).toBe(4)
    expect(d.lanterns).toBe(1)
    expect(d.regions).toBe(1)
  })

  it('counts "today" by the local calendar, not by 24 hours from now', () => {
    row(iso(2026, 6, 14))
    // Late evening of the same day: still today.
    const evening = new Date(2026, 5, 14, 23, 50).getTime()
    expect(islandDigest(state, evening).dueToday).toBe(1)
    // One minute past midnight: yesterday, and now in the shallows.
    const tomorrow = new Date(2026, 5, 15, 0, 1).getTime()
    const d = islandDigest(state, tomorrow)
    expect(d.dueToday).toBe(0)
    expect(d.inShallows).toBe(1)
  })

  it('reports the soonest unfinished due date', () => {
    row(iso(2026, 7, 20))
    row(iso(2026, 6, 30))
    row(iso(2026, 6, 1), true)     // sooner, but finished
    const d = islandDigest(state, NOW)
    expect(d.nextDue).toBe(new Date(2026, 5, 30).getTime())
  })

  it('ignores loose pages and trashed rows', () => {
    stack.execute(new CreatePage())
    const r = row(iso(2026, 6, 10))
    expect(islandDigest(state, NOW).inShallows).toBe(1)
    stack.execute(new DeleteRow(dbId, r))
    expect(islandDigest(state, NOW).inShallows).toBe(0)
  })

  it('counts a database as a region only once it has rows', () => {
    const empty = new CreateDatabase('Empty')
    stack.execute(empty)
    expect(islandDigest(state, NOW).regions).toBe(0)
    row()
    expect(islandDigest(state, NOW).regions).toBe(1)
  })
})
