import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { tendCommand, rescheduleCommand } from './commands'
import { CommandStack, type Command } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreateDatabase, AddRow, AddProperty, SetPropertyValue } from '@/state/databaseCommands'
import { CreatePage } from '@/state/blockCommands'
import { dateToMillis, readBoolean, findProperty } from '@/state/database'
import { derive, elevationFor, STAGE } from '@/island/derive'

/**
 * The join between the island and the store.
 *
 * The point of these tests is Section 2's invariant: tending a plant must
 * produce the *same* command as ticking the box in a table. If the two ever
 * diverge, undo and persistence quietly stop agreeing with the isle.
 */

let state: WorkspaceState
let stack: CommandStack
let dbId: string
let rowId: string
let statusId: string
let dueId: string

const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }

/** Execute a command the Keeper produced, asserting there actually was one. */
const dispatch = (command: Command | null) => {
  expect(command).not.toBeNull()
  stack.execute(command!)
}

beforeEach(() => {
  state = createWorkspace('Test isle', 1_700_000_000_000)
  stack = new CommandStack(run)

  const create = new CreateDatabase('Tasks')
  stack.execute(create)
  dbId = create.databaseId

  const status = new AddProperty(dbId, 'status', 'Status')
  stack.execute(status)
  statusId = status.propertyId

  const due = new AddProperty(dbId, 'date', 'Due')
  stack.execute(due)
  dueId = due.propertyId

  const row = new AddRow(dbId)
  stack.execute(row)
  rowId = row.rowId
})

describe('tendCommand', () => {
  const completeOption = () =>
    findProperty(state.databases[dbId], statusId)!.options!.find((o) => o.group === 'complete')!

  it("sets the user's own complete option, not a name we invented", () => {
    // A Placement Prep board calls it "Offer" and a DSA tracker "Mastered";
    // the island understands the group, never the label.
    dispatch(tendCommand(state, rowId))
    expect(state.pages[rowId].properties?.[statusId]).toBe(completeOption().id)
  })

  it('makes the plant a lantern in the derived island', () => {
    const before = derive(state)
    expect(before.stage[before.ids.indexOf(rowId)]).not.toBe(STAGE.lantern)

    dispatch(tendCommand(state, rowId))

    const after = derive(state)
    expect(after.stage[after.ids.indexOf(rowId)]).toBe(STAGE.lantern)
  })

  it('is exactly the command the table UI would dispatch', () => {
    // Section 2, one command path: tending from the isle and editing the cell
    // in a table must be indistinguishable in the resulting state.
    dispatch(tendCommand(state, rowId))
    const viaIsland = state.pages[rowId].properties?.[statusId]

    // Reset and take the other route.
    stack.undo()
    stack.execute(new SetPropertyValue(rowId, statusId, completeOption().id))
    expect(state.pages[rowId].properties?.[statusId]).toBe(viaIsland)
  })

  it('undoes like any other edit', () => {
    dispatch(tendCommand(state, rowId))
    expect(state.pages[rowId].properties?.[statusId]).toBeTruthy()

    stack.undo()
    expect(state.pages[rowId].properties?.[statusId]).toBeUndefined()
  })

  it('ticks a checkbox when that is all the database has', () => {
    const simple = new CreateDatabase('Simple')
    stack.execute(simple)
    const check = new AddProperty(simple.databaseId, 'checkbox', 'Done')
    stack.execute(check)
    const row = new AddRow(simple.databaseId)
    stack.execute(row)

    dispatch(tendCommand(state, row.rowId))
    expect(readBoolean(state.pages[row.rowId].properties?.[check.propertyId])).toBe(true)
  })

  it('does nothing for a database with no status or checkbox at all', () => {
    const bare = new CreateDatabase('Notes')
    stack.execute(bare)
    const row = new AddRow(bare.databaseId)
    stack.execute(row)
    expect(tendCommand(state, row.rowId)).toBeNull()
  })

  it('does nothing for a page that is not in a database', () => {
    const page = new CreatePage()
    stack.execute(page)
    // Inventing a property on someone's workspace because they walked near a
    // plant would be worse than doing nothing.
    expect(tendCommand(state, page.pageId)).toBeNull()
  })

  it('does nothing for a page that does not exist', () => {
    expect(tendCommand(state, 'no-such-page')).toBeNull()
  })
})

describe('rescheduleCommand', () => {
  const stored = () => state.pages[rowId].properties?.[dueId] as { start: string, hasTime?: boolean }

  it('writes the date the plant was set down at', () => {
    dispatch(rescheduleCommand(state, rowId, new Date(2026, 5, 14).getTime()))
    // A date-only value is a bare calendar day - the same thing
    // `<input type="date">` hands back - and it is read back at *local*
    // midnight, the anchor it was written with. Anchoring at UTC displayed the
    // previous day for everyone west of Greenwich.
    expect(dateToMillis(stored())).toBe(new Date(2026, 5, 14).getTime())
  })

  it('stores a local date, not a UTC-shifted one', () => {
    // toISOString().slice(0, 10) reports yesterday for anyone east of Greenwich
    // in the evening - a bug that only appears for half the world.
    dispatch(rescheduleCommand(state, rowId, new Date(2026, 5, 14, 23, 30).getTime()))
    expect(stored().start).toBe('2026-06-14')
  })

  it('writes a plain day with no time', () => {
    dispatch(rescheduleCommand(state, rowId, new Date(2026, 0, 3, 14, 32).getTime()))
    expect(stored().start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(stored().hasTime).toBeUndefined()
  })

  it('pads single-digit months and days', () => {
    dispatch(rescheduleCommand(state, rowId, new Date(2026, 0, 5).getTime()))
    expect(stored().start).toBe('2026-01-05')
  })

  it('lifts an overdue plant back above the waterline', () => {
    // The whole beachcombing loop. derive() is clock-free by design - the
    // snapshot carries the raw date and the elevation is resolved against
    // `now` in the shader - so the check runs through elevationFor, which is
    // the same function the vertex shader mirrors.
    const now = new Date(2026, 5, 1).getTime()
    stack.execute(new SetPropertyValue(rowId, dueId, { start: '2026-05-20' }))

    const overdue = derive(state)
    const sunk = elevationFor(overdue.due[overdue.ids.indexOf(rowId)], now)
    expect(sunk).toBeLessThan(0)

    dispatch(rescheduleCommand(state, rowId, new Date(2026, 6, 15).getTime()))

    const rescued = derive(state)
    const lifted = elevationFor(rescued.due[rescued.ids.indexOf(rowId)], now)
    expect(lifted).toBeGreaterThan(0)
    expect(lifted).toBeGreaterThan(sunk)
  })

  it('undoes back to the previous due date', () => {
    stack.execute(new SetPropertyValue(rowId, dueId, { start: '2026-05-20' }))
    dispatch(rescheduleCommand(state, rowId, new Date(2026, 6, 15).getTime()))
    stack.undo()
    expect(stored().start).toBe('2026-05-20')
  })

  it('does nothing for a page outside a database', () => {
    const page = new CreatePage()
    stack.execute(page)
    expect(rescheduleCommand(state, page.pageId, Date.now())).toBeNull()
  })

  it('does nothing for a database with no date property', () => {
    const bare = new CreateDatabase('Notes')
    stack.execute(bare)
    const row = new AddRow(bare.databaseId)
    stack.execute(row)
    expect(rescheduleCommand(state, row.rowId, Date.now())).toBeNull()
  })
})
