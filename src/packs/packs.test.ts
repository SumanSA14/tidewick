import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { PACKS, PLACEMENT_PREP, applyPack, OPTION_COLOURS } from './placementPrep'
import { derive, islandDigest, inferMapping } from '@/island/derive'
import { dateToMillis, findProperty } from '@/state/database'

/**
 * Packs are data applied through ordinary commands.
 *
 * Which means two things must hold: applying one is indistinguishable in the
 * resulting state from typing it in, and undoing it leaves nothing behind. The
 * brief also asks that no personal name be hard-coded anywhere, "proven by
 * grep" - the last test here is that grep, run over the pack text.
 */

const NOW = new Date(2026, 5, 14, 10).getTime()

function fresh() {
  let state: WorkspaceState = createWorkspace('packs', NOW)
  const stack = new CommandStack((m) => { state = produce(state, m) })
  return { stack, get: () => state, dispatch: (c: Parameters<CommandStack['execute']>[0]) => stack.execute(c) }
}

describe('applyPack', () => {
  it('creates every database, row and page the pack describes', () => {
    const { get, dispatch } = fresh()
    const applied = applyPack(PLACEMENT_PREP, dispatch, NOW)
    const state = get()

    expect(applied.databaseIds).toHaveLength(PLACEMENT_PREP.databases.length)
    expect(applied.pageIds).toHaveLength(PLACEMENT_PREP.pages.length)

    const rows = PLACEMENT_PREP.databases.reduce((n, d) => n + d.rows.length, 0)
    const rowPages = Object.values(state.pages).filter((p) => p.databaseId).length
    expect(rowPages).toBe(rows)

    const names = Object.values(state.databases).map((d) => d.name).sort()
    expect(names).toEqual(PLACEMENT_PREP.databases.map((d) => d.name).sort())
  })

  it('resolves select values to the option ids it created', () => {
    const { get, dispatch } = fresh()
    applyPack(PLACEMENT_PREP, dispatch, NOW)
    const state = get()
    const ladder = Object.values(state.databases).find((d) => d.name === 'DSA ladder')!
    const topic = ladder.properties.find((p) => p.name === 'Topic')!
    const twoSum = ladder.rows.map((id) => state.pages[id]).find((p) => p.title === 'Two Sum')!

    const stored = twoSum.properties?.[topic.id]
    const option = topic.options?.find((o) => o.id === stored)
    // Stored by id, not by name - a rename of the option must not orphan rows.
    expect(option?.name).toBe('Hashing')
    expect(OPTION_COLOURS).toContain(option?.colour)
  })

  it('lands relative dates as local calendar days from now', () => {
    const { get, dispatch } = fresh()
    applyPack(PLACEMENT_PREP, dispatch, NOW)
    const state = get()
    const ladder = Object.values(state.databases).find((d) => d.name === 'DSA ladder')!
    const due = ladder.properties.find((p) => p.name === 'Due')!
    const twoSum = ladder.rows.map((id) => state.pages[id]).find((p) => p.title === 'Two Sum')!
    // Two Sum is due in two days.
    expect(dateToMillis(twoSum.properties?.[due.id])).toBe(new Date(2026, 5, 16).getTime())
  })

  it('gives the isle regions with plants at real elevations', () => {
    const { get, dispatch } = fresh()
    applyPack(PLACEMENT_PREP, dispatch, NOW)
    const snapshot = derive(get())
    expect(snapshot.regions.length).toBeGreaterThanOrEqual(3)
    expect(snapshot.count).toBeGreaterThan(15)

    const digest = islandDigest(get(), NOW)
    // Nothing arrives overdue: a pack that lands in the shallows would greet a
    // new user with a rescue job.
    expect(digest.inShallows).toBe(0)
    expect(digest.growing).toBeGreaterThan(10)
  })

  it('maps every database onto the island', () => {
    const { get, dispatch } = fresh()
    applyPack(PLACEMENT_PREP, dispatch, NOW)
    for (const database of Object.values(get().databases)) {
      const mapping = inferMapping(database)
      expect(mapping.dueProperty, `${database.name} has a date`).toBeDefined()
      expect(mapping.statusProperty, `${database.name} has a status or checkbox`).toBeDefined()
    }
  })

  it('is one undo away from never having happened', () => {
    const { stack, get, dispatch } = fresh()
    const before = JSON.stringify(get())
    const applied = applyPack(PLACEMENT_PREP, dispatch, NOW)
    for (let i = 0; i < applied.commands; i++) stack.undo()
    expect(JSON.stringify(get())).toBe(before)
  })

  it('writes the page bodies as blocks', () => {
    const { get, dispatch } = fresh()
    const applied = applyPack(PLACEMENT_PREP, dispatch, NOW)
    const guide = get().pages[applied.pageIds[0]]
    expect(guide.title).toBe('How to use this isle')
    const texts = guide.children.map((id) => get().blocks[id].text)
    expect(texts.some((t) => t.includes('Each database is a region'))).toBe(true)
    const types = guide.children.map((id) => get().blocks[id].type)
    expect(types).toContain('heading2')
    expect(types).toContain('callout')
  })

  it('applies every registered pack without error', () => {
    for (const pack of PACKS) {
      const { get, dispatch } = fresh()
      expect(() => applyPack(pack, dispatch, NOW)).not.toThrow()
      expect(Object.keys(get().databases).length).toBe(pack.databases.length)
    }
  })

  it('groups a board by the property the pack names', () => {
    const { get, dispatch } = fresh()
    applyPack(PLACEMENT_PREP, dispatch, NOW)
    const ladder = Object.values(get().databases).find((d) => d.name === 'DSA ladder')!
    const board = ladder.views.find((v) => v.kind === 'board')!
    const topic = findProperty(ladder, board.groupBy ?? '')
    expect(topic?.name).toBe('Topic')
  })

  it('contains no personal names', () => {
    // Section 16: "zero hard-coded personal names, proven by grep". This is
    // that grep, over everything a pack can put on screen. The list is the
    // names that have ever appeared in this project's fixtures and sessions.
    const forbidden = /\b(wren|ash|alice|bob|john|jane)\b/i
    for (const pack of PACKS) {
      const text = JSON.stringify(pack)
      expect(forbidden.test(text), `${pack.name} mentions a person`).toBe(false)
    }
  })
})
