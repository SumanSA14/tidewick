import type { Command } from './commands'
import type { WorkspaceState } from './types'
import {
  createBlock, createPage, cloneBlock, locate, descendants,
  type Block, type BlockType, type Mark,
} from './blocks'

/**
 * Every editor operation, as an invertible Command.
 *
 * The discipline here is that `invert` must restore the *exact* prior state,
 * including the things that are easy to forget: a deleted block's position
 * among its siblings, its whole subtree, and the marks on its text. Anything
 * less and undo drifts, which in this product is worse than in most - the
 * island is a pure function of this tree, so a drifting undo visibly reshapes
 * the world.
 */

export function newId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function touchPage(draft: WorkspaceState, pageId: string): void {
  const page = draft.pages[pageId]
  if (page) page.updatedAt = Date.now()
}

// --- pages -----------------------------------------------------------------

export class CreatePage implements Command {
  readonly label = 'New page'
  readonly pageId: string
  readonly firstBlockId: string

  constructor(private readonly parent: string | null = null, pageId = newId(), firstBlockId = newId()) {
    this.pageId = pageId
    this.firstBlockId = firstBlockId
  }

  apply(draft: WorkspaceState): void {
    const page = createPage(this.pageId, this.parent)
    // A page with no blocks has nowhere to put the caret, so every page is
    // born with one empty paragraph.
    const block = createBlock(this.firstBlockId, this.pageId, null)
    page.children.push(block.id)
    draft.pages[this.pageId] = page
    draft.blocks[block.id] = block
    if (this.parent) draft.pages[this.parent]?.children.push(this.pageId)
    else draft.pageOrder.push(this.pageId)
  }

  invert(draft: WorkspaceState): void {
    delete draft.blocks[this.firstBlockId]
    delete draft.pages[this.pageId]
    if (this.parent) {
      const siblings = draft.pages[this.parent]?.children
      if (siblings) siblings.splice(siblings.indexOf(this.pageId), 1)
    } else {
      draft.pageOrder.splice(draft.pageOrder.indexOf(this.pageId), 1)
    }
  }
}

export class SetPageTitle implements Command {
  readonly label = 'Rename page'
  private before = ''
  private captured = false

  constructor(private readonly pageId: string, private readonly title: string) {}

  apply(draft: WorkspaceState): void {
    const page = draft.pages[this.pageId]
    if (!page) return
    if (!this.captured) {
      this.before = page.title
      this.captured = true
    }
    page.title = this.title
    page.updatedAt = Date.now()
  }

  invert(draft: WorkspaceState): void {
    const page = draft.pages[this.pageId]
    if (page && this.captured) page.title = this.before
  }
}

// --- blocks ----------------------------------------------------------------

/** Insert a new empty block after `afterId`, as its sibling. */
export class InsertBlock implements Command {
  readonly label = 'Insert block'
  readonly blockId: string

  constructor(
    private readonly pageId: string,
    private readonly afterId: string | null,
    private readonly type: BlockType = 'paragraph',
    blockId = newId(),
    private readonly text = '',
    private readonly marks: Mark[] = [],
  ) {
    this.blockId = blockId
  }

  apply(draft: WorkspaceState): void {
    const parent = this.afterId ? draft.blocks[this.afterId]?.parent ?? null : null
    const block = createBlock(this.blockId, this.pageId, parent, this.type)
    block.text = this.text
    block.marks = this.marks.map((m) => ({ ...m }))
    draft.blocks[this.blockId] = block

    const siblings = parent ? draft.blocks[parent]!.children : draft.pages[this.pageId]!.children
    const at = this.afterId ? siblings.indexOf(this.afterId) + 1 : siblings.length
    siblings.splice(at, 0, this.blockId)
    touchPage(draft, this.pageId)
  }

  invert(draft: WorkspaceState): void {
    const found = locate(draft, this.blockId)
    if (found) found.siblings.splice(found.index, 1)
    delete draft.blocks[this.blockId]
    touchPage(draft, this.pageId)
  }
}

/**
 * Delete a block and everything beneath it.
 *
 * The whole subtree is snapshotted on apply, because a block's children are
 * separate entities and dropping the parent alone would orphan them into the
 * store forever - invisible, unreachable, and still derived onto the island.
 */
export class DeleteBlock implements Command {
  readonly label = 'Delete block'
  private snapshot: Block[] = []
  private index = -1
  private captured = false

  constructor(private readonly blockId: string) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    const found = locate(draft, this.blockId)
    if (!found) return

    if (!this.captured) {
      this.index = found.index
      this.snapshot = [block, ...descendants(draft, this.blockId).map((id) => draft.blocks[id])]
        .filter(Boolean)
        .map(cloneBlock)
      this.captured = true
    }

    for (const id of descendants(draft, this.blockId)) delete draft.blocks[id]
    delete draft.blocks[this.blockId]
    found.siblings.splice(found.index, 1)
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    if (!this.captured) return
    for (const b of this.snapshot) draft.blocks[b.id] = cloneBlock(b)
    const root = this.snapshot[0]
    const siblings = root.parent
      ? draft.blocks[root.parent]?.children
      : draft.pages[root.pageId]?.children
    if (siblings) siblings.splice(this.index, 0, root.id)
    touchPage(draft, root.pageId)
  }
}

/**
 * Replace a block's text and marks.
 *
 * Coalescing is handled by the editor rather than here: it merges consecutive
 * keystrokes into one command before dispatching, so undo steps back a word or
 * a burst of typing instead of a single character.
 */
export class SetBlockText implements Command {
  readonly label = 'Type'
  private beforeText = ''
  private beforeMarks: Mark[] = []
  private captured = false

  constructor(
    private readonly blockId: string,
    private text: string,
    private marks: Mark[] = [],
  ) {}

  /** Fold a later edit into this one, so a burst of typing is a single undo. */
  absorb(text: string, marks: Mark[]): void {
    this.text = text
    this.marks = marks
  }

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    if (!this.captured) {
      this.beforeText = block.text
      this.beforeMarks = block.marks.map((m) => ({ ...m }))
      this.captured = true
    }
    block.text = this.text
    block.marks = this.marks.map((m) => ({ ...m }))
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block || !this.captured) return
    block.text = this.beforeText
    block.marks = this.beforeMarks.map((m) => ({ ...m }))
    touchPage(draft, block.pageId)
  }
}

export class SetBlockType implements Command {
  readonly label = 'Change block type'
  private before: BlockType | null = null
  private beforeChecked: boolean | undefined
  private captured = false

  constructor(private readonly blockId: string, private readonly type: BlockType) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    if (!this.captured) {
      this.before = block.type
      this.beforeChecked = block.checked
      this.captured = true
    }
    block.type = this.type
    if (this.type === 'todo' && block.checked === undefined) block.checked = false
    if (this.type === 'toggle' && block.collapsed === undefined) block.collapsed = false
    if (this.type === 'code' && block.language === undefined) block.language = 'text'
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block || !this.captured || this.before === null) return
    block.type = this.before
    block.checked = this.beforeChecked
    touchPage(draft, block.pageId)
  }
}

/**
 * Tick or untick a to-do.
 *
 * This is the command that will, in Phase 4, bloom a plant and light a lantern.
 * It is deliberately the same command whether it comes from a click in the
 * editor or from the Keeper tending the plant out on the island.
 */
export class ToggleTodo implements Command {
  readonly label = 'Complete task'
  private before = false
  private captured = false

  constructor(private readonly blockId: string, private readonly checked?: boolean) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    if (!this.captured) {
      this.before = block.checked ?? false
      this.captured = true
    }
    block.checked = this.checked ?? !this.before
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (block && this.captured) block.checked = this.before
  }
}

export class ToggleCollapsed implements Command {
  readonly label = 'Toggle'
  private before = false
  private captured = false

  constructor(private readonly blockId: string) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    if (!this.captured) {
      this.before = block.collapsed ?? false
      this.captured = true
    }
    block.collapsed = !this.before
  }

  invert(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (block && this.captured) block.collapsed = this.before
  }
}

/**
 * Indent a block, making it a child of its previous sibling.
 *
 * A block with no previous sibling has nothing to nest under, so this is a
 * no-op rather than an error - the editor calls it on every Tab press and does
 * not want to think about whether it will work.
 */
export class IndentBlock implements Command {
  readonly label = 'Indent'
  private previousParent: string | null = null
  private previousIndex = -1
  private moved = false

  constructor(private readonly blockId: string) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    const found = locate(draft, this.blockId)
    if (!block || !found || found.index === 0) return

    const newParentId = found.siblings[found.index - 1]
    const newParent = draft.blocks[newParentId]
    if (!newParent) return

    this.previousParent = block.parent
    this.previousIndex = found.index
    this.moved = true

    found.siblings.splice(found.index, 1)
    newParent.children.push(this.blockId)
    block.parent = newParentId
    reparentSubtree(draft, this.blockId, block.pageId)
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    if (!this.moved) return
    const block = draft.blocks[this.blockId]
    if (!block) return
    const current = locate(draft, this.blockId)
    if (current) current.siblings.splice(current.index, 1)

    block.parent = this.previousParent
    const siblings = this.previousParent
      ? draft.blocks[this.previousParent]?.children
      : draft.pages[block.pageId]?.children
    if (siblings) siblings.splice(this.previousIndex, 0, this.blockId)
    touchPage(draft, block.pageId)
  }
}

/** Outdent a block, making it the next sibling of its former parent. */
export class OutdentBlock implements Command {
  readonly label = 'Outdent'
  private previousParent: string | null = null
  private previousIndex = -1
  private moved = false

  constructor(private readonly blockId: string) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block || !block.parent) return
    const parent = draft.blocks[block.parent]
    const found = locate(draft, this.blockId)
    const parentFound = locate(draft, block.parent)
    if (!parent || !found || !parentFound) return

    this.previousParent = block.parent
    this.previousIndex = found.index
    this.moved = true

    found.siblings.splice(found.index, 1)
    block.parent = parent.parent
    parentFound.siblings.splice(parentFound.index + 1, 0, this.blockId)
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    if (!this.moved) return
    const block = draft.blocks[this.blockId]
    if (!block) return
    const current = locate(draft, this.blockId)
    if (current) current.siblings.splice(current.index, 1)
    block.parent = this.previousParent
    const siblings = this.previousParent ? draft.blocks[this.previousParent]?.children : undefined
    if (siblings) siblings.splice(this.previousIndex, 0, this.blockId)
    touchPage(draft, block.pageId)
  }
}

/** Move a block to an arbitrary position. Used by drag-to-reorder. */
export class MoveBlock implements Command {
  readonly label = 'Move block'
  private fromParent: string | null = null
  private fromIndex = -1
  private moved = false

  constructor(
    private readonly blockId: string,
    private readonly toParent: string | null,
    private readonly toIndex: number,
  ) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    const found = locate(draft, this.blockId)
    if (!block || !found) return
    // Dropping a block inside its own subtree would detach the whole branch
    // from the tree and leak it. Refuse rather than corrupt.
    if (this.toParent && (this.toParent === this.blockId || descendants(draft, this.blockId).includes(this.toParent))) {
      return
    }

    this.fromParent = block.parent
    this.fromIndex = found.index
    this.moved = true

    found.siblings.splice(found.index, 1)
    const target = this.toParent ? draft.blocks[this.toParent]?.children : draft.pages[block.pageId]?.children
    if (!target) return
    target.splice(Math.max(0, Math.min(this.toIndex, target.length)), 0, this.blockId)
    block.parent = this.toParent
    reparentSubtree(draft, this.blockId, block.pageId)
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    if (!this.moved) return
    const block = draft.blocks[this.blockId]
    if (!block) return
    const current = locate(draft, this.blockId)
    if (current) current.siblings.splice(current.index, 1)
    block.parent = this.fromParent
    const siblings = this.fromParent
      ? draft.blocks[this.fromParent]?.children
      : draft.pages[block.pageId]?.children
    if (siblings) siblings.splice(this.fromIndex, 0, this.blockId)
    touchPage(draft, block.pageId)
  }
}

/** Keep the denormalised pageId correct after a move between pages. */
function reparentSubtree(draft: WorkspaceState, rootId: string, pageId: string): void {
  const root = draft.blocks[rootId]
  if (!root) return
  root.pageId = pageId
  for (const id of descendants(draft, rootId)) {
    const child = draft.blocks[id]
    if (child) child.pageId = pageId
  }
}

/**
 * Split a block at the caret: the tail becomes a new sibling below.
 *
 * Bundled as one command rather than a delete plus two inserts, because
 * pressing Enter is one action to the person doing it and should be one
 * press of Ctrl+Z to undo.
 */
export class SplitBlock implements Command {
  readonly label = 'Split block'
  readonly newId: string
  private beforeText = ''
  private beforeMarks: Mark[] = []
  private captured = false

  constructor(
    private readonly blockId: string,
    private readonly offset: number,
    newBlockId = newId(),
  ) {
    this.newId = newBlockId
  }

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    if (!block) return
    if (!this.captured) {
      this.beforeText = block.text
      this.beforeMarks = block.marks.map((m) => ({ ...m }))
      this.captured = true
    }

    const head = this.beforeText.slice(0, this.offset)
    const tail = this.beforeText.slice(this.offset)

    // Continue list types across a split; everything else becomes a paragraph,
    // so pressing Enter at the end of a heading does not make another heading.
    const carried: BlockType =
      block.type === 'bulleted' || block.type === 'numbered' || block.type === 'todo'
        ? block.type
        : 'paragraph'

    const next = createBlock(this.newId, block.pageId, block.parent, carried)
    next.text = tail
    next.marks = sliceMarks(this.beforeMarks, this.offset, this.beforeText.length, -this.offset)

    block.text = head
    block.marks = sliceMarks(this.beforeMarks, 0, this.offset, 0)

    // The tail inherits the children: pressing Enter mid-block should not
    // strand the nested content above the split.
    next.children = block.children
    for (const id of next.children) {
      const child = draft.blocks[id]
      if (child) child.parent = this.newId
    }
    block.children = []

    draft.blocks[this.newId] = next
    const found = locate(draft, this.blockId)
    if (found) found.siblings.splice(found.index + 1, 0, this.newId)
    touchPage(draft, block.pageId)
  }

  invert(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    const next = draft.blocks[this.newId]
    if (!block || !next || !this.captured) return

    block.children = next.children
    for (const id of block.children) {
      const child = draft.blocks[id]
      if (child) child.parent = this.blockId
    }
    block.text = this.beforeText
    block.marks = this.beforeMarks.map((m) => ({ ...m }))

    const found = locate(draft, this.newId)
    if (found) found.siblings.splice(found.index, 1)
    delete draft.blocks[this.newId]
    touchPage(draft, block.pageId)
  }
}

/** Merge a block into the end of the one above it. Backspace at offset zero. */
export class MergeIntoPrevious implements Command {
  readonly label = 'Merge block'
  private snapshot: Block[] = []
  private index = -1
  private previousText = ''
  private previousMarks: Mark[] = []
  private previousId: string | null = null
  private captured = false

  constructor(private readonly blockId: string, private readonly targetId: string) {}

  apply(draft: WorkspaceState): void {
    const block = draft.blocks[this.blockId]
    const target = draft.blocks[this.targetId]
    const found = locate(draft, this.blockId)
    if (!block || !target || !found) return

    if (!this.captured) {
      this.index = found.index
      this.previousId = this.targetId
      this.previousText = target.text
      this.previousMarks = target.marks.map((m) => ({ ...m }))
      this.snapshot = [block, ...descendants(draft, this.blockId).map((id) => draft.blocks[id])]
        .filter(Boolean)
        .map(cloneBlock)
      this.captured = true
    }

    const offset = target.text.length
    target.text += block.text
    target.marks = [
      ...target.marks.map((m) => ({ ...m })),
      ...block.marks.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
    ]
    // Children come along, appended after the target's own.
    for (const id of block.children) {
      const child = draft.blocks[id]
      if (child) child.parent = this.targetId
    }
    target.children.push(...block.children)

    found.siblings.splice(found.index, 1)
    delete draft.blocks[this.blockId]
    touchPage(draft, target.pageId)
  }

  invert(draft: WorkspaceState): void {
    if (!this.captured || !this.previousId) return
    const target = draft.blocks[this.previousId]
    if (!target) return

    const root = this.snapshot[0]
    target.text = this.previousText
    target.marks = this.previousMarks.map((m) => ({ ...m }))
    target.children = target.children.filter((id) => !root.children.includes(id))

    for (const b of this.snapshot) draft.blocks[b.id] = cloneBlock(b)
    const siblings = root.parent
      ? draft.blocks[root.parent]?.children
      : draft.pages[root.pageId]?.children
    if (siblings) siblings.splice(this.index, 0, root.id)
    touchPage(draft, target.pageId)
  }
}

/**
 * Shift marks into a substring's coordinate space, dropping any that fall
 * outside it and clipping any that straddle the boundary.
 */
export function sliceMarks(marks: Mark[], from: number, to: number, shift: number): Mark[] {
  const out: Mark[] = []
  for (const mark of marks) {
    const start = Math.max(mark.start, from)
    const end = Math.min(mark.end, to)
    if (end <= start) continue
    out.push({ ...mark, start: start + shift, end: end + shift })
  }
  return out
}
