import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from './commands'
import { createWorkspace, SCHEMA_VERSION, type WorkspaceState } from './types'
import { CreatePage, SetPageTitle, InsertBlock, SetBlockText, ToggleTodo } from './blockCommands'
import { CreateDatabase, AddProperty, AddRow, SetPropertyValue } from './databaseCommands'
import { exportWorkspace, importWorkspace, pageToMarkdown, exportFilename } from './transfer'

/**
 * Export is the user's guarantee that the data is theirs. So the JSON path
 * round-trips exactly, refuses what it cannot read rather than guessing, and
 * the Markdown path is honest about being lossy.
 */

function build() {
  let state: WorkspaceState = createWorkspace('transfer', 1_700_000_000_000)
  const stack = new CommandStack((m) => { state = produce(state, m) })
  return { stack, get: () => state }
}

describe('JSON export and import', () => {
  it('round-trips a workspace byte for byte', () => {
    const { stack, get } = build()
    const db = new CreateDatabase('Tasks')
    stack.execute(db)
    const due = new AddProperty(db.databaseId, 'date', 'Due')
    stack.execute(due)
    const row = new AddRow(db.databaseId)
    stack.execute(row)
    stack.execute(new SetPropertyValue(row.rowId, due.propertyId, { start: '2026-06-14' }))
    const page = new CreatePage()
    stack.execute(page)
    stack.execute(new SetPageTitle(page.pageId, 'Notes'))

    const text = exportWorkspace(get(), 123)
    const back = importWorkspace(text)
    expect(back.ok).toBe(true)
    if (back.ok) expect(JSON.stringify(back.workspace)).toBe(JSON.stringify(get()))
  })

  it('stamps the schema version and the format', () => {
    const { get } = build()
    const bundle = JSON.parse(exportWorkspace(get(), 5))
    expect(bundle.format).toBe('tidewick-workspace')
    expect(bundle.version).toBe(SCHEMA_VERSION)
    expect(bundle.exportedAt).toBe(5)
  })

  it('refuses a file that is not JSON', () => {
    const result = importWorkspace('this is not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/JSON/)
  })

  it('refuses a file that is not a Tidewick export', () => {
    const result = importWorkspace(JSON.stringify({ hello: 'world' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Tidewick export/)
  })

  it('refuses an export from a newer build rather than guessing at it', () => {
    const { get } = build()
    const bundle = JSON.parse(exportWorkspace(get()))
    bundle.version = SCHEMA_VERSION + 3
    const result = importWorkspace(JSON.stringify(bundle))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/newer/)
  })

  it('fills in what an older export did not have', () => {
    const { get } = build()
    const bundle = JSON.parse(exportWorkspace(get()))
    bundle.version = 3
    delete bundle.workspace.meta.sunlight
    delete bundle.workspace.meta.warmth
    delete bundle.workspace.meta.seasonStartedAt
    delete bundle.workspace.meta.seasonsHarvested
    const result = importWorkspace(JSON.stringify(bundle))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.workspace.meta.sunlight).toBe(0)
      expect(result.workspace.meta.warmth).toBe(1)
      expect(result.workspace.meta.seasonsHarvested).toBe(0)
      expect(result.workspace.meta.seasonStartedAt).toBe(result.workspace.meta.createdAt)
    }
  })

  it('refuses a workspace with no id', () => {
    const { get } = build()
    const bundle = JSON.parse(exportWorkspace(get()))
    delete bundle.workspace.meta.id
    expect(importWorkspace(JSON.stringify(bundle)).ok).toBe(false)
  })
})

describe('Markdown export', () => {
  it('renders headings, lists, to-dos and marks', () => {
    const { stack, get } = build()
    const page = new CreatePage()
    stack.execute(page)
    stack.execute(new SetPageTitle(page.pageId, 'Week one'))
    stack.execute(new SetBlockText(page.firstBlockId, 'Plan the week', [{ type: 'bold', start: 0, end: 4 }]))
    const h = new InsertBlock(page.pageId, page.firstBlockId, 'heading2', undefined, 'Monday')
    stack.execute(h)
    const todo = new InsertBlock(page.pageId, h.blockId, 'todo', undefined, 'Revise trees')
    stack.execute(todo)
    stack.execute(new ToggleTodo(todo.blockId, true))
    const open = new InsertBlock(page.pageId, todo.blockId, 'todo', undefined, 'Mock interview')
    stack.execute(open)
    const quote = new InsertBlock(page.pageId, open.blockId, 'quote', undefined, 'Slow is smooth.')
    stack.execute(quote)

    const md = pageToMarkdown(get(), page.pageId)
    expect(md).toContain('# Week one')
    expect(md).toContain('**Plan** the week')
    expect(md).toContain('## Monday')
    expect(md).toContain('- [x] Revise trees')
    expect(md).toContain('- [ ] Mock interview')
    expect(md).toContain('> Slow is smooth.')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('puts a row\'s properties at the top', () => {
    const { stack, get } = build()
    const db = new CreateDatabase('Tasks')
    stack.execute(db)
    const status = new AddProperty(db.databaseId, 'status', 'Status')
    stack.execute(status)
    const due = new AddProperty(db.databaseId, 'date', 'Due')
    stack.execute(due)
    const row = new AddRow(db.databaseId)
    stack.execute(row)
    stack.execute(new SetPageTitle(row.rowId, 'Two Sum'))
    const complete = get().databases[db.databaseId].properties
      .find((p) => p.id === status.propertyId)!.options!.find((o) => o.group === 'complete')!
    stack.execute(new SetPropertyValue(row.rowId, status.propertyId, complete.id))
    stack.execute(new SetPropertyValue(row.rowId, due.propertyId, { start: '2026-06-14' }))

    const md = pageToMarkdown(get(), row.rowId)
    expect(md).toContain('# Two Sum')
    // Option by *name*, not id: an id in an export is noise to a human.
    expect(md).toContain('**Status:** Complete')
    expect(md).toMatch(/\*\*Due:\*\* .*2026/)
  })

  it('numbers a run of numbered items and restarts after a break', () => {
    const { stack, get } = build()
    const page = new CreatePage()
    stack.execute(page)
    stack.execute(new SetBlockText(page.firstBlockId, 'Intro', []))
    const a = new InsertBlock(page.pageId, page.firstBlockId, 'numbered', undefined, 'One')
    stack.execute(a)
    const b = new InsertBlock(page.pageId, a.blockId, 'numbered', undefined, 'Two')
    stack.execute(b)
    const gap = new InsertBlock(page.pageId, b.blockId, 'paragraph', undefined, 'Pause')
    stack.execute(gap)
    const c = new InsertBlock(page.pageId, gap.blockId, 'numbered', undefined, 'Again')
    stack.execute(c)
    const md = pageToMarkdown(get(), page.pageId)
    expect(md).toContain('1. One')
    expect(md).toContain('2. Two')
    expect(md).toContain('1. Again')
  })

  it('returns an empty string for a page that does not exist', () => {
    const { get } = build()
    expect(pageToMarkdown(get(), 'nope')).toBe('')
  })
})

describe('exportFilename', () => {
  it('makes a safe, dated name from the isle', () => {
    const name = exportFilename('Thornwick Shallows!', 'json', new Date(2026, 5, 14))
    expect(name).toBe('thornwick-shallows-2026-06-14.json')
  })

  it('falls back when the isle has no name', () => {
    expect(exportFilename('', 'md', new Date(2026, 0, 2))).toBe('tidewick-2026-01-02.md')
  })
})
