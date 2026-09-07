import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreatePage } from '@/state/blockCommands'
import {
  CreateDatabase, AddProperty, AddRow, SetPropertyValue, DeleteRow,
} from '@/state/databaseCommands'
import { findProperty } from '@/state/database'
import {
  derive, elevationFor, isBeachcombable, inferMapping,
  NO_DUE_DATE, MEADOW_LEVEL, OVERDUE_FLOOR, STAGE, MS_PER_DAY, LOOSE_PAGES_REGION,
  EMPTY_SNAPSHOT,
} from './derive'
import { ELEVATION_HORIZON_DAYS } from '@/core/config'

/**
 * The island is a pure function of the workspace.
 *
 * These tests are the proof of the claim the whole architecture rests on, so
 * they check it directly: derive twice, get the same island; change one task,
 * get exactly one difference; and never find state on the island that the
 * workspace does not hold.
 */
describe('derive', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let dbId: string
  let statusId: string
  let dueId: string
  let topicId: string
  let estimateId: string

  const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }
  const db = () => state.databases[dbId]

  const statusOption = (group: 'todo' | 'inProgress' | 'complete') =>
    findProperty(db(), statusId)!.options!.find((o) => o.group === group)!.id

  const addRow = (title: string, values: Record<string, unknown> = {}) => {
    const command = new AddRow(dbId)
    stack.execute(command)
    run((draft) => { draft.pages[command.rowId].title = title })
    for (const [key, value] of Object.entries(values)) {
      stack.execute(new SetPropertyValue(command.rowId, key, value as never))
    }
    return command.rowId
  }

  beforeEach(() => {
    state = createWorkspace('ws', 1_700_000_000_000)
    stack = new CommandStack(run)

    const create = new CreateDatabase('DSA Tracker')
    stack.execute(create)
    dbId = create.databaseId

    const status = new AddProperty(dbId, 'status', 'Status')
    stack.execute(status)
    statusId = status.propertyId

    const due = new AddProperty(dbId, 'date', 'Due')
    stack.execute(due)
    dueId = due.propertyId

    const topic = new AddProperty(dbId, 'select', 'Topic')
    stack.execute(topic)
    topicId = topic.propertyId

    const estimate = new AddProperty(dbId, 'number', 'Estimate')
    stack.execute(estimate)
    estimateId = estimate.propertyId
  })

  describe('purity', () => {
    it('is deterministic: the same workspace derives the same island', () => {
      addRow('Two Sum', { [dueId]: { start: '2026-04-01' } })
      addRow('LRU Cache')
      const a = derive(state)
      const b = derive(state)

      expect(a.revision).toBe(b.revision)
      expect(Array.from(a.angle)).toEqual(Array.from(b.angle))
      expect(Array.from(a.due)).toEqual(Array.from(b.due))
      expect(a.ids).toEqual(b.ids)
    })

    it('does not read the clock', () => {
      // If derive consulted `now`, two calls a moment apart would differ - and
      // the island could not be re-derived from a saved workspace to the same
      // shape later. Positions deliberately are not computed here.
      addRow('Two Sum', { [dueId]: { start: '2026-04-01' } })
      const first = derive(state)
      const later = derive(state)
      expect(first.revision).toBe(later.revision)
      expect(Object.keys(first)).not.toContain('position')
    })

    it('changes revision when a task changes, and only then', () => {
      const row = addRow('Two Sum')
      const before = derive(state).revision

      // A change the island does not show must not invalidate it.
      run((draft) => { draft.pages[row].updatedAt = Date.now() + 5000 })
      expect(derive(state).revision).toBe(before)

      stack.execute(new SetPropertyValue(row, statusId, statusOption('complete')))
      expect(derive(state).revision).not.toBe(before)
    })

    it('holds no island state the workspace does not', () => {
      addRow('Two Sum')
      const snapshot = derive(state)
      // Every plant traces back to a live page. Anything else would be state
      // the island invented, which is exactly what Section 2 forbids.
      for (const id of snapshot.ids) {
        expect(state.pages[id]).toBeDefined()
        expect(state.pages[id].trashed).not.toBe(true)
      }
    })
  })

  describe('regions', () => {
    it('gives each database a wedge, and loose pages one of their own', () => {
      addRow('Two Sum')
      stack.execute(new CreatePage(null))
      const snapshot = derive(state)

      expect(snapshot.regions.map((r) => r.sourceId)).toEqual([dbId, LOOSE_PAGES_REGION])
      // Wedges tile without overlapping.
      const [first, second] = snapshot.regions
      expect(first.angleEnd).toBeCloseTo(second.angleStart, 6)
    })

    it('narrows every wedge when a project is added, rather than overlapping', () => {
      addRow('a')
      const oneSpan = derive(state).regions[0].angleEnd - derive(state).regions[0].angleStart

      const second = new CreateDatabase('Applications')
      stack.execute(second)
      const rowB = new AddRow(second.databaseId)
      stack.execute(rowB)

      const after = derive(state)
      const twoSpan = after.regions[0].angleEnd - after.regions[0].angleStart
      expect(twoSpan).toBeLessThan(oneSpan)
      for (let i = 1; i < after.regions.length; i++) {
        expect(after.regions[i].angleStart).toBeGreaterThanOrEqual(after.regions[i - 1].angleEnd - 1e-9)
      }
    })

    it('keeps a region palette stable when a sibling is added', () => {
      addRow('a')
      const before = derive(state).regions[0].palette
      const second = new CreateDatabase('Applications')
      stack.execute(second)
      // Palette comes from the source id, not its index, so a region does not
      // change character because something was created next to it.
      expect(derive(state).regions[0].palette).toBe(before)
    })

    it('leaves an empty sea when there is nothing at all', () => {
      expect(derive(createWorkspace('empty')).count).toBe(0)
    })
  })

  describe('plants', () => {
    it('places a plant per live row and drops trashed ones', () => {
      addRow('kept')
      const gone = addRow('gone')
      expect(derive(state).count).toBe(2)
      stack.execute(new DeleteRow(dbId, gone))
      expect(derive(state).count).toBe(1)
    })

    it('does not move a plant sideways when a sibling is deleted', () => {
      const a = addRow('a')
      const b = addRow('b')
      const before = derive(state)
      const angleOfB = before.angle[before.ids.indexOf(b)]

      stack.execute(new DeleteRow(dbId, a))
      const after = derive(state)
      // Spread comes from the page id, not the row index - otherwise the whole
      // region shuffles every time anything above it is removed.
      expect(after.angle[after.ids.indexOf(b)]).toBeCloseTo(angleOfB, 6)
    })

    it('reads growth stage from the status group, not the option name', () => {
      const todo = addRow('todo', { [statusId]: statusOption('todo') })
      const doing = addRow('doing', { [statusId]: statusOption('inProgress') })
      const done = addRow('done', { [statusId]: statusOption('complete') })

      const s = derive(state)
      expect(s.stage[s.ids.indexOf(todo)]).toBe(STAGE.seed)
      expect(s.stage[s.ids.indexOf(doing)]).toBe(STAGE.sapling)
      expect(s.stage[s.ids.indexOf(done)]).toBe(STAGE.lantern)
    })

    it('understands a renamed status column', () => {
      // The user owns the option names. "Mastered" and "Offer" and "Shipped"
      // are all the complete group, and the island must not need to know which.
      const options = findProperty(db(), statusId)!.options!
      run((draft) => {
        const property = draft.databases[dbId].properties.find((p) => p.id === statusId)!
        property.options!.find((o) => o.group === 'complete')!.name = 'Mastered'
      })
      const row = addRow('x', { [statusId]: options.find((o) => o.group === 'complete')!.id })
      const s = derive(state)
      expect(s.stage[s.ids.indexOf(row)]).toBe(STAGE.lantern)
    })

    it('treats a checkbox as complete when there is no status column', () => {
      const plain = new CreateDatabase('Simple')
      stack.execute(plain)
      const done = new AddProperty(plain.databaseId, 'checkbox', 'Done')
      stack.execute(done)
      const row = new AddRow(plain.databaseId)
      stack.execute(row)
      stack.execute(new SetPropertyValue(row.rowId, done.propertyId, true))

      const s = derive(state)
      expect(s.stage[s.ids.indexOf(row.rowId)]).toBe(STAGE.lantern)
    })

    it('scales with the estimate, but compressively', () => {
      const small = addRow('small', { [estimateId]: 10 })
      const huge = addRow('huge', { [estimateId]: 10_000 })
      const s = derive(state)
      const a = s.scale[s.ids.indexOf(small)]
      const b = s.scale[s.ids.indexOf(huge)]
      expect(b).toBeGreaterThan(a)
      // A thousand-fold estimate must not be a thousand-fold plant, or one
      // task swamps its whole region.
      expect(b / a).toBeLessThan(2)
    })

    it('gives rows with the same topic the same species', () => {
      run((draft) => {
        draft.databases[dbId].properties.find((p) => p.id === topicId)!.options = [
          { id: 'trees', name: 'Trees', colour: 'moss' },
          { id: 'graphs', name: 'Graphs', colour: 'teal' },
        ]
      })
      const a = addRow('a', { [topicId]: 'trees' })
      const b = addRow('b', { [topicId]: 'trees' })
      const c = addRow('c', { [topicId]: 'graphs' })

      const s = derive(state)
      expect(s.species[s.ids.indexOf(a)]).toBe(s.species[s.ids.indexOf(b)])
      expect(s.species[s.ids.indexOf(c)]).not.toBe(s.species[s.ids.indexOf(a)])
    })

    it('numbers entities densely from one, leaving zero to mean nothing', () => {
      addRow('a'); addRow('b'); addRow('c')
      const s = derive(state)
      expect(Array.from(s.entityId)).toEqual([1, 2, 3])
      // Most of the picking buffer is empty sky and sea; zero has to mean that.
      expect(s.entityId).not.toContain(0)
    })
  })

  describe('the schema mapping', () => {
    it('infers the obvious columns rather than demanding configuration', () => {
      const mapping = inferMapping(db())
      expect(mapping.dueProperty).toBe(dueId)
      expect(mapping.statusProperty).toBe(statusId)
      expect(mapping.speciesProperty).toBe(topicId)
      expect(mapping.scaleProperty).toBe(estimateId)
    })

    it('copes with a database that has none of them', () => {
      const bare = new CreateDatabase('Bare')
      stack.execute(bare)
      const row = new AddRow(bare.databaseId)
      stack.execute(row)
      const s = derive(state)
      const i = s.ids.indexOf(row.rowId)
      expect(s.due[i]).toBe(NO_DUE_DATE)
      expect(s.stage[i]).toBe(STAGE.seed)
      expect(s.scale[i]).toBe(1)
    })
  })

  describe('elevation: the heart of the design', () => {
    const now = Date.UTC(2026, 2, 1)

    it('puts the far future at the peak and today at the waterline', () => {
      expect(elevationFor(now + ELEVATION_HORIZON_DAYS * MS_PER_DAY, now)).toBeCloseTo(1, 5)
      expect(elevationFor(now, now)).toBeCloseTo(0, 5)
    })

    it('is linear in time remaining', () => {
      // Half the horizon is half the height. This is the whole mechanic: you
      // read urgency as height without counting anything.
      const half = elevationFor(now + (ELEVATION_HORIZON_DAYS / 2) * MS_PER_DAY, now)
      expect(half).toBeCloseTo(0.5, 5)
    })

    it('descends steadily across the week before a deadline', () => {
      const due = now + 7 * MS_PER_DAY
      const heights = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => elevationFor(due, now + d * MS_PER_DAY))
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i]).toBeLessThan(heights[i - 1])
      }
      expect(heights.at(-1)).toBeCloseTo(0, 5)
    })

    it('caps the peak, so work years out does not float away', () => {
      expect(elevationFor(now + 4000 * MS_PER_DAY, now)).toBe(1)
    })

    it('floors the shallows, so nothing is ever lost', () => {
      // Section 3.3: overdue is a rescue, not a failure. Three weeks late and
      // three months late bob in the same surf.
      const threeWeeks = elevationFor(now - 21 * MS_PER_DAY, now)
      const threeMonths = elevationFor(now - 90 * MS_PER_DAY, now)
      expect(threeWeeks).toBe(OVERDUE_FLOOR)
      expect(threeMonths).toBe(OVERDUE_FLOOR)
      expect(threeMonths).toBeGreaterThan(-1)
    })

    it('puts undated work in the flat meadow, off the gradient', () => {
      // Not everything needs a deadline, and the island must not imply it does.
      expect(elevationFor(NO_DUE_DATE, now)).toBe(MEADOW_LEVEL)
      expect(elevationFor(NO_DUE_DATE, now + 500 * MS_PER_DAY)).toBe(MEADOW_LEVEL)
    })

    it('knows what can be beachcombed', () => {
      expect(isBeachcombable(now - MS_PER_DAY, now)).toBe(true)
      expect(isBeachcombable(now + MS_PER_DAY, now)).toBe(false)
      expect(isBeachcombable(NO_DUE_DATE, now)).toBe(false)
    })
  })

  describe('transferability', () => {
    /**
     * The derive worker transfers every typed array, which detaches the
     * underlying buffer in the worker. Returning a module-level singleton for
     * the empty case therefore poisoned it: the second empty derive threw
     * DataCloneError and the island silently stopped updating for the rest of
     * the session.
     *
     * It only affected a workspace with no databases - which is a brand-new
     * one, which is the first thing a new user sees.
     */
    const buffersOf = (snapshot: ReturnType<typeof derive>) => [
      snapshot.angle.buffer, snapshot.due.buffer, snapshot.jitter.buffer,
      snapshot.species.buffer, snapshot.stage.buffer, snapshot.scale.buffer,
      snapshot.regionIndex.buffer, snapshot.entityId.buffer,
    ]

    it('gives every empty derive its own buffers', () => {
      const empty = createWorkspace('no-databases', 1_700_000_000_000)
      const first = derive(empty)
      const second = derive(empty)

      expect(first.count).toBe(0)
      expect(second.count).toBe(0)
      // Distinct objects and distinct buffers, so transferring one cannot
      // detach the other.
      expect(second).not.toBe(first)
      const a = buffersOf(first)
      const b = buffersOf(second)
      for (let i = 0; i < a.length; i++) expect(b[i]).not.toBe(a[i])
    })

    it('survives transferring an empty snapshot twice', () => {
      const empty = createWorkspace('no-databases', 1_700_000_000_000)
      // structuredClone with a transfer list detaches exactly as postMessage
      // does, so this reproduces the worker's behaviour without a worker.
      const once = derive(empty)
      structuredClone(once, { transfer: buffersOf(once) })

      const twice = derive(empty)
      expect(() => structuredClone(twice, { transfer: buffersOf(twice) })).not.toThrow()
    })

    it('never hands out the shared EMPTY_SNAPSHOT', () => {
      const empty = createWorkspace('no-databases', 1_700_000_000_000)
      expect(derive(empty)).not.toBe(EMPTY_SNAPSHOT)
    })
  })

  describe('scale', () => {
    it('derives thousands of rows without superlinear blow-up', () => {
      /**
       * A scaling assertion, not a stopwatch.
       *
       * Three earlier versions were wrong in instructive ways. It began as an
       * absolute 12 ms budget, which failed the first time the suite grew
       * enough to load the machine. Rewritten as a 2x ratio it was still
       * flaky, because derive allocates ten typed arrays per call: at 2 ms a
       * single GC pause lands inside the sample and a 2x span cannot tell an
       * allocator hiccup from an algorithm change. Widening to 4x then blew
       * the five-second test timeout - not in derive, but in the *setup*,
       * because seeding through the command stack runs one immer produce per
       * row over a growing state, which really is quadratic.
       *
       * So the rows are built in a single produce. This test is about derive,
       * and paying a quadratic setup cost to measure a linear function is a
       * good way to measure neither.
       */
      const time = (run: () => unknown, samples = 11): number => {
        const times: number[] = []
        for (let i = 0; i < samples; i++) {
          const t0 = performance.now()
          run()
          times.push(performance.now() - t0)
        }
        times.sort((a, b) => a - b)
        return times[Math.floor(times.length / 2)]
      }

      const seed = (from: number, to: number) => {
        run((draft) => {
          const database = draft.databases[dbId]
          for (let i = from; i < to; i++) {
            const id = `scale-${i}`
            draft.pages[id] = {
              id,
              title: `Task ${i}`,
              databaseId: dbId,
              properties: i % 3 === 0 ? { [dueId]: { start: '2026-05-01' } } : {},
              children: [],
              parent: null,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
            }
            database.rows.push(id)
          }
        })
      }

      seed(0, 750)
      const small = time(() => derive(state))

      seed(750, 3000)
      const large = time(() => derive(state))

      expect(derive(state).count).toBe(3000)
      // Four times the rows must not cost eight times the work: linear gives
      // about 4, anything quadratic about 16, and the bound sits between them
      // with room for a noisy machine.
      if (small > 0.3) expect(large / small).toBeLessThan(8)
      // A generous absolute backstop for a regression that is slow but linear.
      // The real budget is one frame for a workspace change to reach the isle.
      expect(large).toBeLessThan(80)
    })
  })
})
