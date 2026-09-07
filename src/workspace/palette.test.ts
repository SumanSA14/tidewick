import { describe, it, expect, beforeEach, vi } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from '@/state/commands'
import { createWorkspace, type WorkspaceState } from '@/state/types'
import { CreatePage, SetPageTitle, SetBlockText } from '@/state/blockCommands'
import { CreateDatabase, AddRow } from '@/state/databaseCommands'
import { search, type PaletteAction } from './CommandPalette'

/**
 * The palette's search is a plain scan with a deliberate ranking: a title that
 * starts with the query beats one that contains it, which beats a body match;
 * recently edited breaks ties. No fuzzy matching - it surfaces "Seasons" for
 * "Two Sum" after a week and nobody trusts the box again.
 */
describe('palette search', () => {
  let state: WorkspaceState
  let stack: CommandStack
  const actions: PaletteAction[] = [
    { id: 'new-page', label: 'New page', keywords: ['create', 'blank'], run: vi.fn() },
    { id: 'isle', label: 'Enter the isle', hint: 'Tab', run: vi.fn() },
  ]

  const page = (title: string, body?: string, at = 1_700_000_000_000) => {
    const create = new CreatePage()
    stack.execute(create)
    stack.execute(new SetPageTitle(create.pageId, title))
    if (body) stack.execute(new SetBlockText(create.firstBlockId, body, []))
    state = produce(state, (d) => { d.pages[create.pageId].updatedAt = at })
    return create.pageId
  }

  beforeEach(() => {
    state = createWorkspace('search', 1_700_000_000_000)
    stack = new CommandStack((m) => { state = produce(state, m) })
  })

  it('offers the actions when nothing is typed', () => {
    const hits = search(state, '', actions)
    expect(hits.map((h) => h.title)).toEqual(expect.arrayContaining(['New page', 'Enter the isle']))
  })

  it('ranks a title that starts with the query above one that contains it', () => {
    page('Two Sum')
    page('Revisit Two Sum later')
    const hits = search(state, 'two', [])
    expect(hits[0].title).toBe('Two Sum')
    expect(hits[1].title).toBe('Revisit Two Sum later')
  })

  it('finds text inside a page body and shows where', () => {
    page('Week one', 'Finish the DSA tree chapter before Friday')
    const hits = search(state, 'tree chapter', [])
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Week one')
    expect(hits[0].detail).toContain('tree chapter')
  })

  it('ranks a title match above a body match', () => {
    page('Notes', 'graphs are everywhere')
    page('Graphs')
    const hits = search(state, 'graph', [])
    expect(hits[0].title).toBe('Graphs')
    expect(hits[1].title).toBe('Notes')
  })

  it('breaks ties by recency', () => {
    page('Alpha plan', undefined, 1_000)
    page('Alpha review', undefined, 9_000)
    const hits = search(state, 'alpha', [])
    expect(hits[0].title).toBe('Alpha review')
  })

  it('finds databases and their rows', () => {
    const db = new CreateDatabase('DSA Tracker')
    stack.execute(db)
    const row = new AddRow(db.databaseId)
    stack.execute(row)
    stack.execute(new SetPageTitle(row.rowId, 'LRU Cache'))

    const dbHits = search(state, 'dsa', [])
    expect(dbHits[0].target).toEqual({ kind: 'database', id: db.databaseId })
    expect(dbHits[0].detail).toContain('1 row')

    const rowHits = search(state, 'lru', [])
    expect(rowHits[0].target).toEqual({ kind: 'page', id: row.rowId })
    expect(rowHits[0].detail).toContain('DSA Tracker')
  })

  it('does not match fuzzily', () => {
    page('Seasons')
    expect(search(state, 'sesons', [])).toHaveLength(0)
  })

  it('ignores trashed pages', () => {
    const id = page('Old thing')
    state = produce(state, (d) => { d.pages[id].trashed = true })
    expect(search(state, 'old', [])).toHaveLength(0)
  })

  it('matches actions by keyword', () => {
    const hits = search(state, 'blank', actions)
    expect(hits[0].title).toBe('New page')
  })

  it('caps the list', () => {
    for (let i = 0; i < 40; i++) page(`Item ${i}`)
    expect(search(state, 'item', []).length).toBeLessThanOrEqual(12)
  })

  it('is case-insensitive', () => {
    page('Word Ladder')
    expect(search(state, 'WORD', [])[0].title).toBe('Word Ladder')
  })
})
