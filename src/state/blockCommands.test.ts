import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from './commands'
import { createWorkspace, type WorkspaceState } from './types'
import { flatten, documentOrder, depthOf, orderedIndex, descendants, type BlockType } from './blocks'
import {
  CreatePage, SetPageTitle, InsertBlock, DeleteBlock, SetBlockText, SetBlockType,
  SplitBlock, MergeIntoPrevious, IndentBlock, OutdentBlock, MoveBlock,
  ToggleTodo, ToggleCollapsed, sliceMarks,
} from './blockCommands'

/**
 * Block commands, tested through the stack rather than in isolation.
 *
 * Every test that mutates also undoes, because `invert` is the half that goes
 * wrong quietly: a command that applies correctly and inverts *almost*
 * correctly leaves the tree subtly wrong, and in this product that is not a
 * cosmetic bug - the island is a pure function of this tree, so a drifting
 * undo visibly reshapes the world.
 */
describe('block commands', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let pageId: string
  let firstBlock: string

  const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }

  beforeEach(() => {
    state = createWorkspace('ws', 1_700_000_000_000)
    stack = new CommandStack(run)
    const create = new CreatePage(null)
    stack.execute(create)
    pageId = create.pageId
    firstBlock = create.firstBlockId
  })

  /** Add a sibling below `after` with text, returning its id. */
  const add = (after: string | null, text: string, type: BlockType = 'paragraph') => {
    const insert = new InsertBlock(pageId, after, type)
    stack.execute(insert)
    stack.execute(new SetBlockText(insert.blockId, text))
    return insert.blockId
  }

  describe('pages', () => {
    it('is born with exactly one empty paragraph, so the caret has a home', () => {
      expect(state.pageOrder).toEqual([pageId])
      expect(state.pages[pageId].children).toEqual([firstBlock])
      expect(state.blocks[firstBlock].text).toBe('')
      expect(state.blocks[firstBlock].type).toBe('paragraph')
    })

    it('undoes cleanly, leaving no orphaned blocks behind', () => {
      stack.undo()
      expect(state.pageOrder).toEqual([])
      expect(Object.keys(state.pages)).toEqual([])
      expect(Object.keys(state.blocks)).toEqual([])
    })

    it('renames and reverts', () => {
      stack.execute(new SetPageTitle(pageId, 'Placement prep'))
      expect(state.pages[pageId].title).toBe('Placement prep')
      stack.undo()
      expect(state.pages[pageId].title).toBe('')
    })

    it('nests a page under another', () => {
      const child = new CreatePage(pageId)
      stack.execute(child)
      expect(state.pages[pageId].children).toContain(child.pageId)
      expect(state.pageOrder).toEqual([pageId])
      stack.undo()
      expect(state.pages[pageId].children).not.toContain(child.pageId)
    })
  })

  describe('insert and delete', () => {
    it('inserts after a sibling and undoes', () => {
      const b = add(firstBlock, 'second')
      expect(state.pages[pageId].children).toEqual([firstBlock, b])
      stack.undo()
      stack.undo()
      expect(state.pages[pageId].children).toEqual([firstBlock])
      expect(state.blocks[b]).toBeUndefined()
    })

    it('deletes a whole subtree and restores every descendant', () => {
      const parent = add(firstBlock, 'parent')
      const child = add(parent, 'child')
      stack.execute(new IndentBlock(child))
      const grandchild = add(child, 'grandchild')
      stack.execute(new IndentBlock(grandchild))

      expect(descendants(state, parent).sort()).toEqual([child, grandchild].sort())

      stack.execute(new DeleteBlock(parent))
      expect(state.blocks[parent]).toBeUndefined()
      // Dropping only the parent would leave these in the store forever:
      // invisible, unreachable, and still derived onto the island.
      expect(state.blocks[child]).toBeUndefined()
      expect(state.blocks[grandchild]).toBeUndefined()

      stack.undo()
      expect(state.blocks[parent]).toBeDefined()
      expect(state.blocks[child]?.parent).toBe(parent)
      expect(state.blocks[grandchild]?.parent).toBe(child)
      expect(state.pages[pageId].children).toEqual([firstBlock, parent])
    })

    it('restores a deleted block to its original position, not the end', () => {
      const a = add(firstBlock, 'a')
      const b = add(a, 'b')
      stack.execute(new DeleteBlock(a))
      expect(state.pages[pageId].children).toEqual([firstBlock, b])
      stack.undo()
      expect(state.pages[pageId].children).toEqual([firstBlock, a, b])
    })
  })

  describe('text and type', () => {
    it('sets text and reverts', () => {
      stack.execute(new SetBlockText(firstBlock, 'hello'))
      expect(state.blocks[firstBlock].text).toBe('hello')
      stack.undo()
      expect(state.blocks[firstBlock].text).toBe('')
    })

    it('absorbs a burst of typing into one undo step', () => {
      const command = new SetBlockText(firstBlock, 'h')
      stack.execute(command)
      for (const text of ['he', 'hel', 'hell', 'hello']) {
        command.absorb(text, [])
        expect(stack.amend(command)).toBe(true)
      }
      expect(state.blocks[firstBlock].text).toBe('hello')
      stack.undo()
      // One press of undo, back to the start of the burst - not five presses.
      expect(state.blocks[firstBlock].text).toBe('')
      expect(stack.canUndo).toBe(true)
    })

    it('refuses to amend a command that is no longer on top', () => {
      const command = new SetBlockText(firstBlock, 'a')
      stack.execute(command)
      stack.execute(new SetBlockText(firstBlock, 'b'))
      expect(stack.amend(command)).toBe(false)
    })

    it('changes type and gives to-dos a checkbox state', () => {
      stack.execute(new SetBlockType(firstBlock, 'todo'))
      expect(state.blocks[firstBlock].type).toBe('todo')
      expect(state.blocks[firstBlock].checked).toBe(false)
      stack.undo()
      expect(state.blocks[firstBlock].type).toBe('paragraph')
    })

    it('ticks a to-do and back', () => {
      stack.execute(new SetBlockType(firstBlock, 'todo'))
      stack.execute(new ToggleTodo(firstBlock))
      expect(state.blocks[firstBlock].checked).toBe(true)
      stack.undo()
      expect(state.blocks[firstBlock].checked).toBe(false)
    })

    it('collapses a toggle, hiding its children from the visible order', () => {
      stack.execute(new SetBlockType(firstBlock, 'toggle'))
      const child = add(firstBlock, 'hidden')
      stack.execute(new IndentBlock(child))
      expect(flatten(state, pageId)).toEqual([firstBlock, child])

      stack.execute(new ToggleCollapsed(firstBlock))
      expect(flatten(state, pageId)).toEqual([firstBlock])
      // The block still exists; only the rendered order changes.
      expect(documentOrder(state, pageId)).toEqual([firstBlock, child])
    })
  })

  describe('indent and outdent', () => {
    it('indents under the previous sibling', () => {
      const b = add(firstBlock, 'b')
      stack.execute(new IndentBlock(b))
      expect(state.blocks[b].parent).toBe(firstBlock)
      expect(state.blocks[firstBlock].children).toEqual([b])
      expect(depthOf(state, b)).toBe(1)
      stack.undo()
      expect(state.blocks[b].parent).toBeNull()
      expect(state.pages[pageId].children).toEqual([firstBlock, b])
    })

    it('does nothing when there is no previous sibling to nest under', () => {
      const before = state
      stack.execute(new IndentBlock(firstBlock))
      expect(state.blocks[firstBlock].parent).toBeNull()
      expect(state.pages[pageId].children).toEqual(before.pages[pageId].children)
    })

    it('outdents to just after the former parent', () => {
      const b = add(firstBlock, 'b')
      const c = add(b, 'c')
      stack.execute(new IndentBlock(b))
      stack.execute(new IndentBlock(c))
      expect(depthOf(state, c)).toBe(1)

      stack.execute(new OutdentBlock(c))
      expect(state.blocks[c].parent).toBeNull()
      expect(state.pages[pageId].children).toEqual([firstBlock, c])
      stack.undo()
      expect(state.blocks[c].parent).toBe(firstBlock)
    })

    it('does nothing at the root', () => {
      stack.execute(new OutdentBlock(firstBlock))
      expect(state.blocks[firstBlock].parent).toBeNull()
    })
  })

  describe('move', () => {
    it('reorders within the root', () => {
      const a = add(firstBlock, 'a')
      const b = add(a, 'b')
      stack.execute(new MoveBlock(b, null, 0))
      expect(state.pages[pageId].children).toEqual([b, firstBlock, a])
      stack.undo()
      expect(state.pages[pageId].children).toEqual([firstBlock, a, b])
    })

    it('refuses to drop a block inside its own subtree', () => {
      const parent = add(firstBlock, 'parent')
      const child = add(parent, 'child')
      stack.execute(new IndentBlock(child))
      const before = state.pages[pageId].children.slice()

      // Allowing this detaches the whole branch from the tree and leaks it.
      stack.execute(new MoveBlock(parent, child, 0))
      expect(state.pages[pageId].children).toEqual(before)
      expect(state.blocks[parent].parent).toBeNull()
    })
  })

  describe('split', () => {
    it('splits text at the caret', () => {
      stack.execute(new SetBlockText(firstBlock, 'hello world'))
      const split = new SplitBlock(firstBlock, 5)
      stack.execute(split)
      expect(state.blocks[firstBlock].text).toBe('hello')
      expect(state.blocks[split.newId].text).toBe(' world')
      stack.undo()
      expect(state.blocks[firstBlock].text).toBe('hello world')
      expect(state.blocks[split.newId]).toBeUndefined()
    })

    it('continues list types but not headings', () => {
      stack.execute(new SetBlockType(firstBlock, 'bulleted'))
      stack.execute(new SetBlockText(firstBlock, 'item'))
      const listSplit = new SplitBlock(firstBlock, 4)
      stack.execute(listSplit)
      expect(state.blocks[listSplit.newId].type).toBe('bulleted')

      const h = add(null, 'Title', 'heading1')
      const headingSplit = new SplitBlock(h, 5)
      stack.execute(headingSplit)
      // Pressing Enter at the end of a heading should not make another heading.
      expect(state.blocks[headingSplit.newId].type).toBe('paragraph')
    })

    it('hands the children to the tail, not the head', () => {
      const child = add(firstBlock, 'child')
      stack.execute(new IndentBlock(child))
      stack.execute(new SetBlockText(firstBlock, 'parent text'))

      const split = new SplitBlock(firstBlock, 6)
      stack.execute(split)
      // Keeping them on the head would strand nested content above the split.
      expect(state.blocks[split.newId].children).toEqual([child])
      expect(state.blocks[firstBlock].children).toEqual([])
      expect(state.blocks[child].parent).toBe(split.newId)

      stack.undo()
      expect(state.blocks[firstBlock].children).toEqual([child])
      expect(state.blocks[child].parent).toBe(firstBlock)
    })

    it('carries marks into the correct half', () => {
      stack.execute(new SetBlockText(firstBlock, 'bold plain', [{ start: 0, end: 4, type: 'bold' }]))
      const split = new SplitBlock(firstBlock, 5)
      stack.execute(split)
      expect(state.blocks[firstBlock].marks).toEqual([{ start: 0, end: 4, type: 'bold' }])
      expect(state.blocks[split.newId].marks).toEqual([])
    })
  })

  describe('merge', () => {
    it('joins into the previous block and restores on undo', () => {
      stack.execute(new SetBlockText(firstBlock, 'hello'))
      const b = add(firstBlock, ' world')
      stack.execute(new MergeIntoPrevious(b, firstBlock))
      expect(state.blocks[firstBlock].text).toBe('hello world')
      expect(state.blocks[b]).toBeUndefined()

      stack.undo()
      expect(state.blocks[firstBlock].text).toBe('hello')
      expect(state.blocks[b]?.text).toBe(' world')
      expect(state.pages[pageId].children).toEqual([firstBlock, b])
    })

    it('shifts the merged block marks by the join offset', () => {
      stack.execute(new SetBlockText(firstBlock, 'abc'))
      const b = add(firstBlock, 'XY')
      stack.execute(new SetBlockText(b, 'XY', [{ start: 0, end: 2, type: 'bold' }]))
      stack.execute(new MergeIntoPrevious(b, firstBlock))
      expect(state.blocks[firstBlock].text).toBe('abcXY')
      expect(state.blocks[firstBlock].marks).toEqual([{ start: 3, end: 5, type: 'bold' }])
    })

    it('adopts the merged block children', () => {
      const b = add(firstBlock, 'b')
      const child = add(b, 'child')
      stack.execute(new IndentBlock(child))
      stack.execute(new MergeIntoPrevious(b, firstBlock))
      expect(state.blocks[firstBlock].children).toEqual([child])
      expect(state.blocks[child].parent).toBe(firstBlock)
      stack.undo()
      expect(state.blocks[firstBlock].children).toEqual([])
      expect(state.blocks[child].parent).toBe(b)
    })
  })

  describe('numbering', () => {
    it('restarts after a non-numbered block', () => {
      const one = add(firstBlock, 'one', 'numbered')
      const two = add(one, 'two', 'numbered')
      const gap = add(two, 'a paragraph')
      const three = add(gap, 'three', 'numbered')

      expect(orderedIndex(state, one)).toBe(1)
      expect(orderedIndex(state, two)).toBe(2)
      // Counting the sibling index instead would call this 4.
      expect(orderedIndex(state, three)).toBe(1)
    })
  })

  describe('a long session', () => {
    it('undoes 100 mixed operations back to the starting tree', () => {
      const snapshot = JSON.stringify({ pages: state.pages, blocks: state.blocks, order: state.pageOrder })
      let previous = firstBlock
      for (let i = 0; i < 50; i++) {
        const id = add(previous, `line ${i}`)
        if (i % 3 === 0) stack.execute(new IndentBlock(id))
        if (i % 7 === 0) stack.execute(new SetBlockType(id, 'todo'))
        previous = id
      }
      while (stack.canUndo) stack.undo()
      expect(JSON.stringify({ pages: state.pages, blocks: state.blocks, order: state.pageOrder }))
        .not.toBe(snapshot) // the page creation itself is also undone
      expect(state.pageOrder).toEqual([])
      expect(Object.keys(state.blocks)).toEqual([])
    })

    it('leaves no unreachable blocks after heavy editing', () => {
      let previous = firstBlock
      for (let i = 0; i < 20; i++) previous = add(previous, `line ${i}`)
      stack.execute(new IndentBlock(previous))
      stack.execute(new DeleteBlock(state.pages[pageId].children[3]))

      const reachable = new Set(documentOrder(state, pageId))
      for (const id of Object.keys(state.blocks)) {
        expect(reachable.has(id)).toBe(true)
      }
    })
  })
})

describe('sliceMarks', () => {
  it('clips marks that straddle the boundary and shifts the rest', () => {
    const marks = [
      { start: 0, end: 3, type: 'bold' as const },
      { start: 2, end: 8, type: 'italic' as const },
      { start: 9, end: 12, type: 'code' as const },
    ]
    expect(sliceMarks(marks, 0, 5, 0)).toEqual([
      { start: 0, end: 3, type: 'bold' },
      { start: 2, end: 5, type: 'italic' },
    ])
    expect(sliceMarks(marks, 5, 12, -5)).toEqual([
      { start: 0, end: 3, type: 'italic' },
      { start: 4, end: 7, type: 'code' },
    ])
  })

  it('drops marks that collapse to nothing', () => {
    expect(sliceMarks([{ start: 4, end: 4, type: 'bold' }], 0, 10, 0)).toEqual([])
    expect(sliceMarks([{ start: 8, end: 9, type: 'bold' }], 0, 5, 0)).toEqual([])
  })
})
