import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import {
  CreateDatabase, AddProperty, AddRow, SetPropertyValue, UpdateView,
  AddSelectOption, DeleteProperty, DeleteRow, AddView, DeleteView,
  ReorderProperty, ReorderRow, UpdateProperty, toggleSort,
} from '@/state/databaseCommands'
import { runQuery, valueOf, EMPTY_GROUP_KEY } from './query'
import { findProperty, type FilterRule, type FilterGroup } from '@/state/database'

/**
 * The query engine is the shared answer.
 *
 * A Board column, a Table row list and - from Phase 4 - a region of the island
 * are the same query over the same data. If this is wrong, the workspace and
 * the isle disagree about reality, which is precisely the failure the whole
 * architecture is arranged to prevent.
 */
describe('databases and queries', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let dbId: string
  let titleId: string
  let viewId: string
  let statusId: string
  let estimateId: string
  let dueId: string
  let doneId: string

  const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }
  const db = () => state.databases[dbId]
  const view = () => db().views.find((v) => v.id === viewId)!
  const query = () => runQuery(state, db(), view())

  const rule = (propertyId: string, operator: FilterRule['operator'], value?: FilterRule['value']): FilterRule =>
    ({ kind: 'rule', id: `r-${propertyId}-${operator}`, propertyId, operator, value })

  const setFilter = (children: FilterGroup['children'], op: 'and' | 'or' = 'and') => {
    stack.execute(new UpdateView(dbId, viewId, {
      filter: { kind: 'group', id: 'root', op, children },
    }))
  }

  const addRow = (values: Record<string, unknown>) => {
    const command = new AddRow(dbId)
    stack.execute(command)
    for (const [key, value] of Object.entries(values)) {
      if (key === 'title') {
        run((draft) => { draft.pages[command.rowId].title = value as string })
      } else {
        stack.execute(new SetPropertyValue(command.rowId, key, value as never))
      }
    }
    return command.rowId
  }

  beforeEach(() => {
    state = createWorkspace('ws', 1_700_000_000_000)
    stack = new CommandStack(run)

    const create = new CreateDatabase('DSA Tracker')
    stack.execute(create)
    dbId = create.databaseId
    titleId = create.titlePropertyId
    viewId = create.viewId

    const status = new AddProperty(dbId, 'status', 'Status')
    stack.execute(status)
    statusId = status.propertyId

    const estimate = new AddProperty(dbId, 'number', 'Estimate')
    stack.execute(estimate)
    estimateId = estimate.propertyId

    const due = new AddProperty(dbId, 'date', 'Due')
    stack.execute(due)
    dueId = due.propertyId

    const done = new AddProperty(dbId, 'checkbox', 'Done')
    stack.execute(done)
    doneId = done.propertyId
  })

  describe('schema', () => {
    it('starts with exactly one title property and one table view', () => {
      expect(db().properties.filter((p) => p.type === 'title')).toHaveLength(1)
      expect(db().views).toHaveLength(1)
      expect(db().views[0].kind).toBe('table')
    })

    it('gives a status property its three groups without being asked', () => {
      const status = findProperty(db(), statusId)!
      expect(status.options).toHaveLength(3)
      expect(status.options!.map((o) => o.group)).toEqual(['todo', 'inProgress', 'complete'])
    })

    it('shows a new property in every existing view', () => {
      const extra = new AddProperty(dbId, 'text', 'Notes')
      stack.execute(extra)
      expect(view().visibleProperties).toContain(extra.propertyId)
      stack.undo()
      expect(view().visibleProperties).not.toContain(extra.propertyId)
      expect(findProperty(db(), extra.propertyId)).toBeUndefined()
    })

    it('refuses to delete the title property', () => {
      stack.execute(new DeleteProperty(dbId, titleId))
      expect(findProperty(db(), titleId)).toBeDefined()
    })

    it('restores a deleted property with every value intact', () => {
      const a = addRow({ title: 'Two Sum', [estimateId]: 30 })
      const b = addRow({ title: 'LRU Cache', [estimateId]: 90 })

      stack.execute(new DeleteProperty(dbId, estimateId))
      expect(findProperty(db(), estimateId)).toBeUndefined()
      expect(state.pages[a].properties?.[estimateId]).toBeUndefined()

      stack.undo()
      // Restoring the column but not its contents would be a data loss dressed
      // up as an undo.
      expect(state.pages[a].properties?.[estimateId]).toBe(30)
      expect(state.pages[b].properties?.[estimateId]).toBe(90)
      expect(view().visibleProperties).toContain(estimateId)
    })

    it('prunes filters, sorts and grouping that referenced a deleted property', () => {
      setFilter([rule(estimateId, 'greaterThan', 10)])
      stack.execute(new UpdateView(dbId, viewId, {
        sorts: [{ propertyId: estimateId, direction: 'asc' }],
        groupBy: estimateId,
      }))

      stack.execute(new DeleteProperty(dbId, estimateId))
      expect(view().filter.children).toHaveLength(0)
      expect(view().sorts).toHaveLength(0)
      expect(view().groupBy).toBeUndefined()
    })

    it('reorders properties and back', () => {
      const before = db().properties.map((p) => p.id)
      stack.execute(new ReorderProperty(dbId, doneId, 1))
      expect(db().properties[1].id).toBe(doneId)
      stack.undo()
      expect(db().properties.map((p) => p.id)).toEqual(before)
    })

    it('edits a property and reverts every field', () => {
      stack.execute(new UpdateProperty(dbId, estimateId, { name: 'Minutes', numberFormat: 'integer' }))
      expect(findProperty(db(), estimateId)?.name).toBe('Minutes')
      stack.undo()
      expect(findProperty(db(), estimateId)?.name).toBe('Estimate')
      expect(findProperty(db(), estimateId)?.numberFormat).toBe('plain')
    })
  })

  describe('rows', () => {
    it('creates a row as a page with a body block', () => {
      const id = addRow({ title: 'Two Sum' })
      const page = state.pages[id]
      expect(page.databaseId).toBe(dbId)
      expect(page.children).toHaveLength(1)
      expect(state.blocks[page.children[0]]).toBeDefined()
    })

    it('soft-deletes, so nothing real is destroyed', () => {
      const id = addRow({ title: 'Two Sum' })
      stack.execute(new DeleteRow(dbId, id))
      expect(db().rows).not.toContain(id)
      // The page and its blocks survive, so the trash can restore them.
      expect(state.pages[id]).toBeDefined()
      expect(state.pages[id].trashed).toBe(true)

      stack.undo()
      expect(db().rows).toContain(id)
      expect(state.pages[id].trashed).toBe(false)
    })

    it('excludes trashed rows from queries', () => {
      addRow({ title: 'kept' })
      const gone = addRow({ title: 'gone' })
      stack.execute(new DeleteRow(dbId, gone))
      expect(query().rows).toHaveLength(1)
    })

    it('reorders and reverts', () => {
      const a = addRow({ title: 'a' })
      const b = addRow({ title: 'b' })
      const c = addRow({ title: 'c' })
      stack.execute(new ReorderRow(dbId, c, 0))
      expect(db().rows).toEqual([c, a, b])
      stack.undo()
      expect(db().rows).toEqual([a, b, c])
    })
  })

  describe('computed values', () => {
    it('reads a title from the page, not from the property bag', () => {
      const id = addRow({ title: 'Two Sum' })
      const property = findProperty(db(), titleId)!
      expect(valueOf(state, state.pages[id], property)).toBe('Two Sum')
    })

    it('derives created and last-edited times', () => {
      const id = addRow({ title: 'x' })
      const created = findProperty(db(), titleId)!
      void created
      const page = state.pages[id]
      const createdProp = { id: 'c', name: 'Created', type: 'createdTime' as const }
      const value = valueOf(state, page, createdProp)
      expect(value).toMatchObject({ hasTime: true })
    })
  })

  describe('filtering', () => {
    beforeEach(() => {
      addRow({ title: 'Two Sum', [estimateId]: 30, [dueId]: { start: '2026-03-10' }, [doneId]: true })
      addRow({ title: 'LRU Cache', [estimateId]: 90, [dueId]: { start: '2026-03-20' } })
      addRow({ title: 'Word Ladder', [estimateId]: 60 })
    })

    it('returns everything when no filter is set', () => {
      expect(query().rows).toHaveLength(3)
      expect(query().total).toBe(3)
    })

    it('treats an empty filter group as matching everything', () => {
      // The alternative - an empty AND vacuously true but an empty OR
      // vacuously false - hides every row the moment you add a group.
      setFilter([{ kind: 'group', id: 'g', op: 'or', children: [] }])
      expect(query().rows).toHaveLength(3)
    })

    it('filters on text', () => {
      setFilter([rule(titleId, 'contains', 'cache')])
      expect(query().rows).toHaveLength(1)
    })

    it('filters on numbers', () => {
      setFilter([rule(estimateId, 'greaterThan', 45)])
      expect(query().rows).toHaveLength(2)
      setFilter([rule(estimateId, 'lessOrEqual', 60)])
      expect(query().rows).toHaveLength(2)
    })

    it('filters on emptiness', () => {
      setFilter([rule(dueId, 'isEmpty')])
      expect(query().rows).toHaveLength(1)
      setFilter([rule(dueId, 'isNotEmpty')])
      expect(query().rows).toHaveLength(2)
    })

    it('filters checkboxes', () => {
      setFilter([rule(doneId, 'checked')])
      expect(query().rows).toHaveLength(1)
      setFilter([rule(doneId, 'unchecked')])
      expect(query().rows).toHaveLength(2)
    })

    it('compares dates by day, not by instant', () => {
      addRow({ title: 'Afternoon', [dueId]: { start: '2026-03-10T15:30:00.000Z', hasTime: true } })
      setFilter([rule(dueId, 'is', { start: '2026-03-10' })])
      // Both the all-day row and the mid-afternoon one are on 10 March.
      expect(query().rows).toHaveLength(2)
    })

    it('filters dates before and after', () => {
      setFilter([rule(dueId, 'before', { start: '2026-03-15' })])
      expect(query().rows).toHaveLength(1)
      setFilter([rule(dueId, 'onOrAfter', { start: '2026-03-10' })])
      expect(query().rows).toHaveLength(2)
    })

    it('composes rules with AND', () => {
      setFilter([rule(estimateId, 'greaterThan', 20), rule(dueId, 'isNotEmpty')], 'and')
      expect(query().rows).toHaveLength(2)
    })

    it('composes rules with OR', () => {
      setFilter([rule(estimateId, 'greaterThan', 80), rule(doneId, 'checked')], 'or')
      expect(query().rows).toHaveLength(2)
    })

    it('nests a group inside a group', () => {
      // (estimate > 20) AND (done is checked OR estimate < 70)
      setFilter([
        rule(estimateId, 'greaterThan', 20),
        {
          kind: 'group', id: 'inner', op: 'or',
          children: [rule(doneId, 'checked'), rule(estimateId, 'lessThan', 70)],
        },
      ], 'and')
      const titles = query().rows.map((id) => state.pages[id].title).sort()
      expect(titles).toEqual(['Two Sum', 'Word Ladder'])
    })

    it('ignores a half-written rule rather than hiding everything', () => {
      setFilter([rule(titleId, 'contains', '')])
      expect(query().rows).toHaveLength(3)
    })

    it('ignores a rule pointing at a property that no longer exists', () => {
      setFilter([rule('ghost', 'is', 'anything')])
      expect(query().rows).toHaveLength(3)
    })
  })

  describe('sorting', () => {
    beforeEach(() => {
      addRow({ title: 'Beta', [estimateId]: 60 })
      addRow({ title: 'alpha', [estimateId]: 30 })
      addRow({ title: 'Gamma' })
    })

    const titles = () => query().rows.map((id) => state.pages[id].title)

    it('sorts numerically', () => {
      stack.execute(new UpdateView(dbId, viewId, { sorts: [{ propertyId: estimateId, direction: 'asc' }] }))
      expect(titles()).toEqual(['alpha', 'Beta', 'Gamma'])
    })

    it('keeps empty values last when the sort is reversed', () => {
      stack.execute(new UpdateView(dbId, viewId, { sorts: [{ propertyId: estimateId, direction: 'desc' }] }))
      // Treating empty as "smallest" would float every unfilled row to the top
      // on a descending sort, which nobody has ever wanted.
      expect(titles()).toEqual(['Beta', 'alpha', 'Gamma'])
    })

    it('sorts text case-insensitively', () => {
      stack.execute(new UpdateView(dbId, viewId, { sorts: [{ propertyId: titleId, direction: 'asc' }] }))
      expect(titles()).toEqual(['alpha', 'Beta', 'Gamma'])
    })

    it('breaks ties with the next sort level', () => {
      addRow({ title: 'alpha', [estimateId]: 90 })
      stack.execute(new UpdateView(dbId, viewId, {
        sorts: [
          { propertyId: titleId, direction: 'asc' },
          { propertyId: estimateId, direction: 'desc' },
        ],
      }))
      const rows = query().rows.map((id) => state.pages[id])
      expect(rows[0].title).toBe('alpha')
      expect(rows[0].properties?.[estimateId]).toBe(90)
    })

    it('sorts status by the option order, not alphabetically', () => {
      const options = findProperty(db(), statusId)!.options!
      const todo = options.find((o) => o.group === 'todo')!.id
      const complete = options.find((o) => o.group === 'complete')!.id

      const rows = query().rows
      stack.execute(new SetPropertyValue(rows[0], statusId, complete))
      stack.execute(new SetPropertyValue(rows[1], statusId, todo))
      stack.execute(new UpdateView(dbId, viewId, { sorts: [{ propertyId: statusId, direction: 'asc' }] }))

      // Alphabetically "Complete" precedes "To-do"; by group order it must not.
      const order = query().rows.map((id) => state.pages[id].properties?.[statusId])
      expect(order[0]).toBe(todo)
    })

    it('is stable for equal rows', () => {
      stack.execute(new UpdateView(dbId, viewId, { sorts: [{ propertyId: statusId, direction: 'asc' }] }))
      const first = query().rows
      const second = query().rows
      expect(first).toEqual(second)
    })
  })

  describe('grouping', () => {
    it('seeds a column for every declared option, even empty ones', () => {
      addRow({ title: 'unset' })
      stack.execute(new UpdateView(dbId, viewId, { kind: 'board', groupBy: statusId }))
      const groups = query().groups!
      // A Board that silently drops an unused status is a Board that loses work.
      expect(groups.filter((g) => g.key !== EMPTY_GROUP_KEY)).toHaveLength(3)
    })

    it('puts unset rows in a trailing empty group', () => {
      addRow({ title: 'unset' })
      stack.execute(new UpdateView(dbId, viewId, { groupBy: statusId }))
      const groups = query().groups!
      expect(groups.at(-1)!.key).toBe(EMPTY_GROUP_KEY)
      expect(groups.at(-1)!.rows).toHaveLength(1)
    })

    it('groups by a select option', () => {
      const topic = new AddProperty(dbId, 'select', 'Topic')
      stack.execute(topic)
      const trees = new AddSelectOption(dbId, topic.propertyId, 'Trees', 'moss')
      stack.execute(trees)

      const a = addRow({ title: 'a' })
      stack.execute(new SetPropertyValue(a, topic.propertyId, trees.optionId))
      addRow({ title: 'b' })

      stack.execute(new UpdateView(dbId, viewId, { groupBy: topic.propertyId }))
      const groups = query().groups!
      expect(groups.find((g) => g.key === trees.optionId)!.rows).toHaveLength(1)
      expect(groups.find((g) => g.key === EMPTY_GROUP_KEY)!.rows).toHaveLength(1)
    })

    it('returns no groups when the view does not group', () => {
      expect(query().groups).toBeNull()
    })
  })

  describe('views', () => {
    it('adds a board and picks a grouping property from the schema', () => {
      const board = new AddView(dbId, 'By status', 'board')
      stack.execute(board)
      const added = db().views.find((v) => v.id === board.viewId)!
      expect(added.groupBy).toBe(statusId)
    })

    it('adds a calendar and picks a date property', () => {
      const calendar = new AddView(dbId, 'Schedule', 'calendar')
      stack.execute(calendar)
      expect(db().views.find((v) => v.id === calendar.viewId)!.dateProperty).toBe(dueId)
    })

    it('never deletes the last view', () => {
      stack.execute(new DeleteView(dbId, viewId))
      expect(db().views).toHaveLength(1)
    })

    it('deletes and restores a configured view exactly', () => {
      const board = new AddView(dbId, 'By status', 'board')
      stack.execute(board)
      setFilter([rule(estimateId, 'greaterThan', 5)])
      stack.execute(new UpdateView(dbId, board.viewId, { sorts: [{ propertyId: titleId, direction: 'desc' }] }))

      stack.execute(new DeleteView(dbId, board.viewId))
      expect(db().views).toHaveLength(1)

      stack.undo()
      const restored = db().views.find((v) => v.id === board.viewId)!
      expect(restored.sorts).toEqual([{ propertyId: titleId, direction: 'desc' }])
    })

    it('cycles a column sort asc, desc, off', () => {
      let sorts = toggleSort([], titleId)
      expect(sorts).toEqual([{ propertyId: titleId, direction: 'asc' }])
      sorts = toggleSort(sorts, titleId)
      expect(sorts[0].direction).toBe('desc')
      sorts = toggleSort(sorts, titleId)
      expect(sorts).toEqual([])
    })
  })

  describe('scale', () => {
    /** Median of several runs, so one unlucky GC pause does not decide it. */
    const timeQuery = (run: () => unknown, samples = 11): number => {
      const times: number[] = []
      for (let i = 0; i < samples; i++) {
        const start = performance.now()
        run()
        times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      return times[Math.floor(times.length / 2)]
    }

    /**
     * A deliberately low-cardinality sort key.
     *
     * This matters more than it looks. An earlier version of this test sorted
     * by estimate and then by a unique title, which meant the sort keys
     * resolved every comparison and the stable tie-break never ran at all - so
     * the test could not have caught the tie-break bug it claimed to guard.
     * Reintroducing that bug against the old test changed the measured time by
     * nothing. Three distinct values over 500 rows leaves large tie groups, and
     * the tie-break comparator is then on the hot path where it belongs.
     */
    const seedRows = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        addRow({ title: `Problem ${i}`, [estimateId]: (i % 3) * 40 + 20 })
      }
    }

    it('filters, sorts and groups 500 rows without superlinear blow-up', () => {
      stack.execute(new UpdateView(dbId, viewId, {
        sorts: [{ propertyId: estimateId, direction: 'desc' }],
        groupBy: statusId,
        filter: { kind: 'group', id: 'root', op: 'and', children: [rule(estimateId, 'greaterThan', 10)] },
      }))

      seedRows(0, 250)
      const half = timeQuery(query)

      seedRows(250, 500)
      const full = timeQuery(query)

      const result = query()
      expect(result.total).toBe(500)
      expect(result.rows.length).toBe(500)

      // **A scaling assertion, not a stopwatch.** The previous absolute
      // millisecond budget failed the first time the suite grew enough to load
      // the machine, which is precisely how a timing test teaches people to
      // ignore it. Doubling the rows should roughly double the work;
      // contention inflates both measurements and cancels out.
      //
      // Verified in both directions: restoring the O(n^2 log n) tie-break
      // (rows.indexOf() inside the comparator) makes this ratio fail.
      if (half > 0.4) {
        expect(full / half).toBeLessThan(3)
      }

      // A generous absolute backstop, well clear of the 16 ms frame budget,
      // for a regression that is slow but linear.
      expect(full).toBeLessThan(12)
    })

    it('sorts text without superlinear blow-up', () => {
      // Text sorting on its own path, since the comparator differs.
      //
      // Note what this does *not* cover: the collator finding from the same
      // investigation - localeCompare(a, undefined, opts) rebuilding an
      // Intl.Collator on each of ~4,500 calls - is a constant factor, and a
      // ratio test is blind to constant factors by construction. Reintroducing
      // it leaves this ratio at ~2 and the test green. Only the absolute
      // backstop below could catch it, and only if it were far worse. The
      // shared COLLATOR in query.ts is guarded by review, not by this test.
      stack.execute(new UpdateView(dbId, viewId, {
        sorts: [{ propertyId: titleId, direction: 'asc' }],
      }))
      seedRows(0, 250)
      const half = timeQuery(query)
      seedRows(250, 500)
      const full = timeQuery(query)

      if (half > 0.4) expect(full / half).toBeLessThan(3)
      expect(full).toBeLessThan(12)
    })
  })

  describe('undoing object-valued properties', () => {
    /**
     * Undo entries capture the previous value *during* an Immer produce, so an
     * object- or array-valued property is captured as a live draft proxy. The
     * proxy is revoked when the produce ends, and writing it back on undo threw
     * "Cannot perform 'get' on a proxy that has been revoked".
     *
     * This was reachable from the ordinary date picker - set a date, change it,
     * press Ctrl+Z - and it affected every non-primitive property type. Found
     * while wiring the Keeper's reschedule, which goes through the same command.
     * `clonePropertyValue` in database.ts is the fix; `cloneBlock` exists for
     * exactly the same reason.
     */
    it('undoes a changed date without crashing', () => {
      const row = new AddRow(dbId)
      stack.execute(row)
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-05-20' }))
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-07-15' }))

      expect(() => stack.undo()).not.toThrow()
      expect(state.pages[row.rowId].properties?.[dueId]).toEqual({ start: '2026-05-20' })
    })

    it('undoes a changed multi-select without crashing', () => {
      const tags = new AddProperty(dbId, 'multiSelect', 'Tags')
      stack.execute(tags)
      const row = new AddRow(dbId)
      stack.execute(row)
      stack.execute(new SetPropertyValue(row.rowId, tags.propertyId, ['a']))
      stack.execute(new SetPropertyValue(row.rowId, tags.propertyId, ['a', 'b']))

      expect(() => stack.undo()).not.toThrow()
      expect(state.pages[row.rowId].properties?.[tags.propertyId]).toEqual(['a'])
    })

    it('detaches the captured value from the store', () => {
      // The undo entry must not alias live state, or a later edit would
      // silently rewrite history.
      const row = new AddRow(dbId)
      stack.execute(row)
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-05-20' }))
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-07-15' }))
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-09-01' }))

      stack.undo()
      expect(state.pages[row.rowId].properties?.[dueId]).toEqual({ start: '2026-07-15' })
      stack.undo()
      expect(state.pages[row.rowId].properties?.[dueId]).toEqual({ start: '2026-05-20' })
    })

    it('still undoes back to an absent value', () => {
      const row = new AddRow(dbId)
      stack.execute(row)
      stack.execute(new SetPropertyValue(row.rowId, dueId, { start: '2026-05-20' }))
      stack.undo()
      expect(state.pages[row.rowId].properties?.[dueId]).toBeUndefined()
    })
  })
})
