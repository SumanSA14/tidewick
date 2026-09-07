import type { PropertyValue } from './database'

/**
 * The block model.
 *
 * Blocks are entities in the normalised store, not nodes in an editor's private
 * document. That is a deliberate rejection of dropping ProseMirror in here, and
 * it buys three things the architecture actually requires:
 *
 *   1. `derive()` reads blocks directly. A checklist item becomes a bud on a
 *      plant by looking at a block, not by walking a serialised document.
 *   2. The dirty set is per-block, so typing in one paragraph re-derives one
 *      entity rather than a whole page.
 *   3. There is one undo history. An editor with its own transaction stack
 *      would mean reconciling two of them, which Section 2 exists to forbid.
 *
 * The cost is that inline editing is hand-written. That cost is real, and it is
 * paid in `editor/inline.ts`.
 */

export type BlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulleted'
  | 'numbered'
  | 'todo'
  | 'toggle'
  | 'quote'
  | 'callout'
  | 'divider'
  | 'code'

export type MarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link'

/**
 * An inline mark over a half-open character range.
 *
 * Ranges rather than nested nodes: overlapping bold and italic is a normal
 * thing to want, and a tree forces one to be the parent of the other, which
 * turns "extend the bold a bit" into a restructuring problem.
 */
export interface Mark {
  start: number
  end: number
  type: MarkType
  href?: string
}

export interface Block {
  id: string
  type: BlockType
  text: string
  marks: Mark[]
  /** Ordered child block ids. Nesting is arbitrary depth. */
  children: string[]
  /** Owning block id, or null when the block sits at page root. */
  parent: string | null
  /** Page this block belongs to. Denormalised so lookups do not walk upward. */
  pageId: string
  checked?: boolean
  collapsed?: boolean
  language?: string
}

export interface Page {
  id: string
  title: string
  /**
   * Set when this page is a row of a database. Rows are pages, so a row has a
   * title, a body of blocks and property values, and the island does not need
   * two code paths for "a task" depending on where it was created.
   */
  databaseId?: string
  /** Property values, keyed by property id. Only meaningful for rows. */
  properties?: Record<string, PropertyValue>
  /** Ordered root block ids. */
  children: string[]
  /** Parent page id for the sidebar tree, or null at top level. */
  parent: string | null
  createdAt: number
  updatedAt: number
  favourite?: boolean
  trashed?: boolean
}

/** Types that hold no text and cannot be typed into. */
export const VOID_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>(['divider'])

/** Types that can contain other blocks. */
export const CONTAINER_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>([
  'paragraph', 'bulleted', 'numbered', 'todo', 'toggle', 'quote', 'callout',
  'heading1', 'heading2', 'heading3',
])

export function createBlock(id: string, pageId: string, parent: string | null, type: BlockType = 'paragraph'): Block {
  const block: Block = { id, type, text: '', marks: [], children: [], parent, pageId }
  if (type === 'todo') block.checked = false
  if (type === 'toggle') block.collapsed = false
  if (type === 'code') block.language = 'text'
  return block
}

/**
 * Deep-copy a block by hand.
 *
 * `structuredClone` looks like the obvious choice and throws a DataCloneError
 * here: commands snapshot blocks from inside an Immer producer, where every
 * object is a revocable Proxy, and the structured-clone algorithm refuses
 * proxies outright. Copying the fields explicitly also keeps the snapshot to
 * exactly the shape a Block has, so a stale field from an older schema cannot
 * ride along inside an undo entry.
 */
export function cloneBlock(block: Block): Block {
  const copy: Block = {
    id: block.id,
    type: block.type,
    text: block.text,
    marks: block.marks.map((m) => ({ ...m })),
    children: [...block.children],
    parent: block.parent,
    pageId: block.pageId,
  }
  if (block.checked !== undefined) copy.checked = block.checked
  if (block.collapsed !== undefined) copy.collapsed = block.collapsed
  if (block.language !== undefined) copy.language = block.language
  return copy
}

export function createPage(id: string, parent: string | null, now = Date.now()): Page {
  return { id, title: '', children: [], parent, createdAt: now, updatedAt: now }
}

// --- pure tree helpers -----------------------------------------------------

export interface BlockLookup {
  blocks: Record<string, Block>
  pages: Record<string, Page>
}

/** The ordered sibling list a block lives in, and its index within it. */
export function locate(state: BlockLookup, blockId: string): { siblings: string[]; index: number } | null {
  const block = state.blocks[blockId]
  if (!block) return null
  const siblings = block.parent
    ? state.blocks[block.parent]?.children
    : state.pages[block.pageId]?.children
  if (!siblings) return null
  const index = siblings.indexOf(blockId)
  return index === -1 ? null : { siblings, index }
}

/**
 * Depth-first order, which is the order blocks appear on screen.
 * Collapsed toggles hide their children, so the editor and this agree.
 */
export function flatten(state: BlockLookup, pageId: string, respectCollapse = true): string[] {
  const page = state.pages[pageId]
  if (!page) return []
  const out: string[] = []
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const block = state.blocks[id]
      if (!block) continue
      out.push(id)
      if (block.children.length && !(respectCollapse && block.collapsed)) walk(block.children)
    }
  }
  walk(page.children)
  return out
}

/** Every descendant of a block, deepest last. Used when deleting a subtree. */
export function descendants(state: BlockLookup, blockId: string): string[] {
  const out: string[] = []
  const walk = (id: string) => {
    const block = state.blocks[id]
    if (!block) return
    for (const child of block.children) {
      out.push(child)
      walk(child)
    }
  }
  walk(blockId)
  return out
}

export function depthOf(state: BlockLookup, blockId: string): number {
  let depth = 0
  let current = state.blocks[blockId]?.parent
  while (current) {
    depth++
    current = state.blocks[current]?.parent
  }
  return depth
}

/**
 * The ordinal of a numbered-list block among its immediate run.
 *
 * Counts backwards only while the previous sibling is also numbered, so a
 * paragraph between two lists restarts the numbering - which is what everyone
 * expects and what a naive "index within siblings" gets wrong.
 */
export function orderedIndex(state: BlockLookup, blockId: string): number {
  const found = locate(state, blockId)
  if (!found) return 1
  let count = 1
  for (let i = found.index - 1; i >= 0; i--) {
    if (state.blocks[found.siblings[i]]?.type !== 'numbered') break
    count++
  }
  return count
}

/** Ids in document order, restricted to a page. Handy for tests and export. */
export function documentOrder(state: BlockLookup, pageId: string): string[] {
  return flatten(state, pageId, false)
}
