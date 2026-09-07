import type { Command } from '@/state/commands'
import { CreatePage, SetPageTitle, InsertBlock } from '@/state/blockCommands'
import { CreateDatabase, AddProperty, AddSelectOption, AddRow, AddView, UpdateView, SetPropertyValue } from '@/state/databaseCommands'
import type { BlockType } from '@/state/blocks'
import type { PropertyType, ViewKind } from '@/state/database'

/**
 * Starter packs, as data.
 *
 * Section 6.2 and Section 17 say the same thing from two directions: no schema
 * is hard-coded into the engine, and the Placement Prep pack is data, not code.
 * So a pack is a plain description - databases with properties and rows, pages
 * with blocks - and `applyPack` turns it into the ordinary commands the user
 * would have dispatched by hand. There is no special import path; applying a
 * pack is indistinguishable from someone typing it in, which is also why it is
 * one undo away from never having happened.
 *
 * Dates are relative to "now" so the pack lands with real elevations on the
 * isle: something due in three days sits near the water, the mock interview in
 * six weeks sits high on the hill. A pack shipped with fixed dates would arrive
 * already in the shallows.
 */

export interface PackSelectOption {
  name: string
  colour: string
}

export interface PackProperty {
  type: PropertyType
  name: string
  options?: PackSelectOption[]
}

export interface PackRow {
  title: string
  /** Property values by property *name*; dates as days from now. */
  values?: Record<string, string | number | boolean | string[] | { daysFromNow: number }>
  /** Body paragraphs for the row's page. */
  notes?: string[]
}

export interface PackDatabase {
  name: string
  properties: PackProperty[]
  rows: PackRow[]
  /** Extra views beyond the default table. */
  views?: Array<{ name: string; kind: ViewKind; groupBy?: string }>
}

export interface PackBlock {
  type: BlockType
  text: string
}

export interface PackPage {
  title: string
  blocks: PackBlock[]
}

export interface Pack {
  id: string
  name: string
  /** One line for the templates menu. */
  tagline: string
  databases: PackDatabase[]
  pages: PackPage[]
}

/** The colours a select option can wear. Same vocabulary as database.css. */
export const OPTION_COLOURS = ['slate', 'teal', 'moss', 'sand', 'amber', 'clay', 'lilac', 'sky'] as const

/**
 * Placement Prep.
 *
 * A DSA tracker with topics and a difficulty ladder, a company pipeline, a
 * revision schedule, and a few pages of structure. Titles are deliberately the
 * problems and companies a final-year student actually writes down, because a
 * template full of "Example task 1" teaches nothing about how the isle reads
 * real work.
 *
 * No personal names anywhere. The brief asks for a grep to prove it.
 */
export const PLACEMENT_PREP: Pack = {
  id: 'placement-prep',
  name: 'Placement prep',
  tagline: 'A DSA ladder, a company pipeline and a revision plan, ready to tend.',
  databases: [
    {
      name: 'DSA ladder',
      properties: [
        { type: 'status', name: 'Status' },
        { type: 'date', name: 'Due' },
        { type: 'select', name: 'Topic', options: [
          { name: 'Arrays', colour: 'teal' }, { name: 'Strings', colour: 'sky' },
          { name: 'Linked lists', colour: 'sand' }, { name: 'Trees', colour: 'moss' },
          { name: 'Graphs', colour: 'lilac' }, { name: 'Dynamic programming', colour: 'amber' },
          { name: 'Hashing', colour: 'clay' }, { name: 'Heaps', colour: 'slate' },
        ] },
        { type: 'select', name: 'Difficulty', options: [
          { name: 'Easy', colour: 'moss' }, { name: 'Medium', colour: 'amber' }, { name: 'Hard', colour: 'clay' },
        ] },
        { type: 'number', name: 'Attempts' },
      ],
      views: [{ name: 'By topic', kind: 'board', groupBy: 'Topic' }],
      rows: [
        { title: 'Two Sum', values: { Topic: 'Hashing', Difficulty: 'Easy', Due: { daysFromNow: 2 } } },
        { title: 'Valid Anagram', values: { Topic: 'Strings', Difficulty: 'Easy', Due: { daysFromNow: 3 } } },
        { title: 'Best Time to Buy and Sell Stock', values: { Topic: 'Arrays', Difficulty: 'Easy', Due: { daysFromNow: 4 } } },
        { title: 'Reverse Linked List', values: { Topic: 'Linked lists', Difficulty: 'Easy', Due: { daysFromNow: 6 } } },
        { title: 'Binary Tree Level Order Traversal', values: { Topic: 'Trees', Difficulty: 'Medium', Due: { daysFromNow: 9 } } },
        { title: 'Longest Substring Without Repeating Characters', values: { Topic: 'Strings', Difficulty: 'Medium', Due: { daysFromNow: 12 } } },
        { title: 'Number of Islands', values: { Topic: 'Graphs', Difficulty: 'Medium', Due: { daysFromNow: 16 } } },
        { title: 'Coin Change', values: { Topic: 'Dynamic programming', Difficulty: 'Medium', Due: { daysFromNow: 21 } } },
        { title: 'Kth Largest Element', values: { Topic: 'Heaps', Difficulty: 'Medium', Due: { daysFromNow: 25 } } },
        { title: 'Course Schedule', values: { Topic: 'Graphs', Difficulty: 'Medium', Due: { daysFromNow: 30 } } },
        { title: 'Trapping Rain Water', values: { Topic: 'Arrays', Difficulty: 'Hard', Due: { daysFromNow: 40 } } },
        { title: 'Word Ladder', values: { Topic: 'Graphs', Difficulty: 'Hard', Due: { daysFromNow: 52 } } },
        { title: 'Median of Two Sorted Arrays', values: { Topic: 'Arrays', Difficulty: 'Hard', Due: { daysFromNow: 66 } } },
      ],
    },
    {
      name: 'Company pipeline',
      properties: [
        { type: 'status', name: 'Stage' },
        { type: 'date', name: 'Next step' },
        { type: 'select', name: 'Role', options: [
          { name: 'Software engineer', colour: 'teal' }, { name: 'Application developer', colour: 'sky' },
          { name: 'Data engineer', colour: 'lilac' }, { name: 'Production support', colour: 'sand' },
        ] },
        { type: 'url', name: 'Posting' },
      ],
      views: [{ name: 'Pipeline', kind: 'board', groupBy: 'Stage' }],
      rows: [
        { title: 'Campus drive — round one', values: { Role: 'Software engineer', 'Next step': { daysFromNow: 5 } } },
        { title: 'Referral follow-up', values: { Role: 'Application developer', 'Next step': { daysFromNow: 8 } } },
        { title: 'Online assessment', values: { Role: 'Software engineer', 'Next step': { daysFromNow: 14 } } },
        { title: 'Mock interview with a senior', values: { Role: 'Software engineer', 'Next step': { daysFromNow: 42 } } },
      ],
    },
    {
      name: 'Revision schedule',
      properties: [
        { type: 'checkbox', name: 'Done' },
        { type: 'date', name: 'When' },
        { type: 'select', name: 'Subject', options: [
          { name: 'Operating systems', colour: 'slate' }, { name: 'Databases', colour: 'teal' },
          { name: 'Networks', colour: 'sky' }, { name: 'System design', colour: 'amber' }, { name: 'Java', colour: 'clay' },
        ] },
      ],
      views: [{ name: 'Calendar', kind: 'calendar' }],
      rows: [
        { title: 'Process scheduling and deadlocks', values: { Subject: 'Operating systems', When: { daysFromNow: 1 } } },
        { title: 'Indexing and normalisation', values: { Subject: 'Databases', When: { daysFromNow: 3 } } },
        { title: 'TCP handshake, HTTP, DNS', values: { Subject: 'Networks', When: { daysFromNow: 7 } } },
        { title: 'Collections and concurrency', values: { Subject: 'Java', When: { daysFromNow: 10 } } },
        { title: 'Design a URL shortener', values: { Subject: 'System design', When: { daysFromNow: 18 } } },
      ],
    },
  ],
  pages: [
    {
      title: 'How to use this isle',
      blocks: [
        { type: 'heading2', text: 'The mapping' },
        { type: 'paragraph', text: 'Each database is a region of the island. Each row is a plant. Its due date is its height on the slope: the far future is up the hill, today is the waterline, and anything overdue bobs in the shallows until you lift it.' },
        { type: 'paragraph', text: 'Finishing a task lights a lantern. Lanterns are permanent.' },
        { type: 'heading2', text: 'The loop' },
        { type: 'numbered', text: 'Plan: put the week into the ladder and the pipeline.' },
        { type: 'numbered', text: 'Focus: run a session. The light warms while you work; Sunlight only comes from measured focus.' },
        { type: 'numbered', text: 'Tend: complete things here, or walk up to them on the isle and press E.' },
        { type: 'numbered', text: 'Harvest: every fortnight the season turns and writes you a keepsake.' },
        { type: 'callout', text: 'Nothing here can be lost. Overdue is a place on the map, not a failure.' },
      ],
    },
    {
      title: 'Interview stories',
      blocks: [
        { type: 'paragraph', text: 'One story per heading. Situation, what you did, what changed. Keep each under a minute out loud.' },
        { type: 'heading3', text: 'A bug you were proud of finding' },
        { type: 'paragraph', text: '' },
        { type: 'heading3', text: 'Something you shipped under time pressure' },
        { type: 'paragraph', text: '' },
        { type: 'heading3', text: 'A time you changed your mind' },
        { type: 'paragraph', text: '' },
      ],
    },
  ],
}

/** A small, general template: a week that reviews itself. */
export const WEEKLY_REVIEW: Pack = {
  id: 'weekly-review',
  name: 'Weekly review',
  tagline: 'One database of intentions and a page to look back from.',
  databases: [
    {
      name: 'This week',
      properties: [
        { type: 'status', name: 'Status' },
        { type: 'date', name: 'By' },
        { type: 'select', name: 'Kind', options: [
          { name: 'Deep work', colour: 'teal' }, { name: 'Admin', colour: 'slate' },
          { name: 'People', colour: 'sand' }, { name: 'Rest', colour: 'moss' },
        ] },
      ],
      views: [{ name: 'Board', kind: 'board', groupBy: 'Status' }],
      rows: [
        { title: 'The one thing that matters most this week', values: { Kind: 'Deep work', By: { daysFromNow: 3 } } },
        { title: 'Clear the small things in one sitting', values: { Kind: 'Admin', By: { daysFromNow: 2 } } },
        { title: 'A proper walk with no headphones', values: { Kind: 'Rest', By: { daysFromNow: 5 } } },
      ],
    },
  ],
  pages: [
    {
      title: 'Looking back',
      blocks: [
        { type: 'heading2', text: 'What went well' },
        { type: 'bulleted', text: '' },
        { type: 'heading2', text: 'What I would do differently' },
        { type: 'bulleted', text: '' },
        { type: 'heading2', text: 'Next week, in one sentence' },
        { type: 'paragraph', text: '' },
      ],
    },
  ],
}

export const READING_LIST: Pack = {
  id: 'reading-list',
  name: 'Reading list',
  tagline: 'Books and papers as plants: the ones you finish become lanterns.',
  databases: [
    {
      name: 'Reading',
      properties: [
        { type: 'status', name: 'Status' },
        { type: 'date', name: 'Finish by' },
        { type: 'select', name: 'Shelf', options: [
          { name: 'Technical', colour: 'teal' }, { name: 'Fiction', colour: 'lilac' },
          { name: 'Essays', colour: 'sand' }, { name: 'Papers', colour: 'slate' },
        ] },
        { type: 'number', name: 'Pages' },
      ],
      rows: [
        { title: 'Something long you have been putting off', values: { Shelf: 'Fiction', 'Finish by': { daysFromNow: 45 } } },
        { title: 'A paper from the reading group', values: { Shelf: 'Papers', 'Finish by': { daysFromNow: 6 } } },
      ],
    },
  ],
  pages: [],
}

export const PACKS: Pack[] = [PLACEMENT_PREP, WEEKLY_REVIEW, READING_LIST]

export interface AppliedPack {
  /** Page ids created, in order. Useful for opening the first one. */
  pageIds: string[]
  databaseIds: string[]
  /** Everything dispatched, so a caller can count or test it. */
  commands: number
}

/**
 * Turn a pack into the commands a person would have dispatched.
 *
 * `dispatch` is whatever the store exposes; nothing here reads state back,
 * which is what keeps the pack applicable to any workspace regardless of what
 * it already contains. Option ids are resolved from the commands that created
 * them, and a status property's built-in options are looked up by group so the
 * pack never has to know how the engine names "complete".
 */
export function applyPack(
  pack: Pack,
  dispatch: (command: Command) => void,
  now = Date.now(),
): AppliedPack {
  const pageIds: string[] = []
  const databaseIds: string[] = []
  let commands = 0
  const run = (command: Command) => { dispatch(command); commands++ }

  for (const db of pack.databases) {
    const create = new CreateDatabase(db.name)
    run(create)
    databaseIds.push(create.databaseId)

    const propertyIds = new Map<string, string>()
    const optionIds = new Map<string, Map<string, string>>()

    for (const property of db.properties) {
      const add = new AddProperty(create.databaseId, property.type, property.name)
      run(add)
      propertyIds.set(property.name, add.propertyId)
      if (property.options) {
        const ids = new Map<string, string>()
        for (const option of property.options) {
          const addOption = new AddSelectOption(create.databaseId, add.propertyId, option.name, option.colour)
          run(addOption)
          ids.set(option.name, addOption.optionId)
        }
        optionIds.set(property.name, ids)
      }
    }

    for (const view of db.views ?? []) {
      const add = new AddView(create.databaseId, view.name, view.kind)
      run(add)
      if (view.groupBy) {
        const groupId = propertyIds.get(view.groupBy)
        if (groupId) run(new UpdateView(create.databaseId, add.viewId, { groupBy: groupId }, 'Group board'))
      }
    }

    for (const row of db.rows) {
      const add = new AddRow(create.databaseId)
      run(add)
      run(new SetPageTitle(add.rowId, row.title))
      for (const [name, raw] of Object.entries(row.values ?? {})) {
        const propertyId = propertyIds.get(name)
        if (!propertyId) continue
        const value = resolveValue(raw, optionIds.get(name), now)
        if (value !== undefined) run(new SetPropertyValue(add.rowId, propertyId, value))
      }
      let after: string | null = add.firstBlockId
      for (const note of row.notes ?? []) {
        const insert = new InsertBlock(add.rowId, after, 'paragraph', undefined, note)
        run(insert)
        after = insert.blockId
      }
    }
  }

  for (const page of pack.pages) {
    const create = new CreatePage(null)
    run(create)
    run(new SetPageTitle(create.pageId, page.title))
    pageIds.push(create.pageId)
    let after: string | null = create.firstBlockId
    for (const block of page.blocks) {
      // The fourth argument is the block *id*; the text is fifth. Passing the
      // text there compiled fine - both are strings - and produced pages whose
      // blocks were empty and whose ids were sentences.
      const insert = new InsertBlock(create.pageId, after, block.type, undefined, block.text)
      run(insert)
      after = insert.blockId
    }
  }

  return { pageIds, databaseIds, commands }
}

function resolveValue(
  raw: string | number | boolean | string[] | { daysFromNow: number },
  options: Map<string, string> | undefined,
  now: number,
) {
  if (typeof raw === 'object' && raw !== null && 'daysFromNow' in raw) {
    const d = new Date(now + raw.daysFromNow * 86_400_000)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return { start: `${d.getFullYear()}-${month}-${day}` }
  }
  if (typeof raw === 'string' && options) {
    return options.get(raw) ?? raw
  }
  if (Array.isArray(raw) && options) {
    return raw.map((r) => options.get(r) ?? r)
  }
  return raw
}
