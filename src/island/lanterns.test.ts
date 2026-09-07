import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreateDatabase, AddProperty, AddRow, SetPropertyValue, DeleteRow } from '@/state/databaseCommands'
import { CreatePage } from '@/state/blockCommands'
import { countLanterns } from './derive'

/**
 * The lantern count is derived, never stored.
 *
 * The home page used to read `meta.lanternsLit`, a counter only the Keeper's
 * tend incremented. Complete a task in the table and the hill lit a lantern
 * while the page still said zero. Section 2 settles it: the count comes from
 * the same reading of "done" as the plants.
 */
describe('countLanterns', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let dbId: string
  let statusId: string
  let completeId: string

  beforeEach(() => {
    state = createWorkspace('lanterns', 1_700_000_000_000)
    stack = new CommandStack((m) => { state = produce(state, m) })
    const db = new CreateDatabase('Tasks')
    stack.execute(db)
    dbId = db.databaseId
    const status = new AddProperty(dbId, 'status', 'Status')
    stack.execute(status)
    statusId = status.propertyId
    completeId = state.databases[dbId].properties
      .find((p) => p.id === statusId)!.options!.find((o) => o.group === 'complete')!.id
  })

  const addRow = () => { const r = new AddRow(dbId); stack.execute(r); return r.rowId }

  it('is zero on a fresh isle', () => {
    expect(countLanterns(state)).toBe(0)
  })

  it('counts tasks completed from the table, not just from the isle', () => {
    const a = addRow()
    const b = addRow()
    addRow()
    stack.execute(new SetPropertyValue(a, statusId, completeId))
    stack.execute(new SetPropertyValue(b, statusId, completeId))
    expect(countLanterns(state)).toBe(2)
    // The stored counter was never touched - and the count is right anyway.
    expect(state.meta.lanternsLit).toBe(0)
  })

  it('ignores loose pages and trashed rows', () => {
    stack.execute(new CreatePage())
    const row = addRow()
    stack.execute(new SetPropertyValue(row, statusId, completeId))
    expect(countLanterns(state)).toBe(1)
    stack.execute(new DeleteRow(dbId, row))
    expect(countLanterns(state)).toBe(0)
  })

  it('follows undo', () => {
    const row = addRow()
    stack.execute(new SetPropertyValue(row, statusId, completeId))
    expect(countLanterns(state)).toBe(1)
    stack.undo()
    expect(countLanterns(state)).toBe(0)
  })
})
