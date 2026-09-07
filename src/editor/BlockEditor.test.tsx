/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { BlockEditor } from './BlockEditor'
import { useWorkspaceStore } from '@/state/store'
import { createWorkspace } from '@/state/types'
import { CreatePage } from '@/state/blockCommands'
import { flatten } from '@/state/blocks'
import { setCaretOffset } from './inline'

/**
 * Editor behaviour, driven through real key events.
 *
 * These exist because the browser automation available to this project cannot
 * send keyboard input: its key events arrive with `key: ""`, `code: ""` and
 * `which: 0`, so Enter, Tab and Backspace are all indistinguishable from each
 * other and from nothing. Every keyboard behaviour in the editor is therefore
 * unverifiable by clicking around, and has to be pinned down here instead.
 */

const store = () => useWorkspaceStore.getState()

function setup() {
  useWorkspaceStore.getState().hydrate(createWorkspace('test-ws', 1_700_000_000_000))
  const create = new CreatePage(null)
  store().dispatch(create)
  const view = render(<BlockEditor pageId={create.pageId} />)
  return { ...view, pageId: create.pageId, firstBlock: create.firstBlockId }
}

/** The contenteditable for a block, by index in visible order. */
function rowAt(index: number): HTMLElement {
  const rows = document.querySelectorAll<HTMLElement>('.row__text')
  const el = rows[index]
  if (!el) throw new Error(`no row at index ${index}`)
  return el
}

/**
 * Type into a contenteditable the way the browser does: mutate, fire input,
 * and leave the caret after the inserted text.
 *
 * The caret placement is not decoration. jsdom reports offset 0 for a freshly
 * focused element, and the editor reads the caret to decide what Enter, Space
 * and Backspace mean - so without this every Markdown shortcut silently sees an
 * empty prefix and every Enter splits at the start of the line.
 */
function typeInto(el: HTMLElement, text: string) {
  el.focus()
  fireEvent.focus(el)
  el.textContent = text
  fireEvent.input(el)
  setCaretOffset(el, text.length)
}

function press(el: HTMLElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(el, { key, bubbles: true, ...opts })
}

describe('BlockEditor', () => {
  let pageId: string
  let firstBlock: string

  beforeEach(() => {
    const s = setup()
    pageId = s.pageId
    firstBlock = s.firstBlock
  })

  afterEach(cleanup)

  it('renders the page title and one empty block', () => {
    expect(screen.getByLabelText('Page title')).toBeInTheDocument()
    expect(document.querySelectorAll('.row')).toHaveLength(1)
  })

  it('writes typed text into the store', () => {
    typeInto(rowAt(0), 'hello')
    expect(store().workspace.blocks[firstBlock].text).toBe('hello')
  })

  it('coalesces a burst of typing into a single undo', () => {
    const el = rowAt(0)
    typeInto(el, 'h')
    typeInto(el, 'he')
    typeInto(el, 'hel')
    typeInto(el, 'hello')
    expect(store().workspace.blocks[firstBlock].text).toBe('hello')

    store().undo()
    // One undo, back to empty - not four.
    expect(store().workspace.blocks[firstBlock].text).toBe('')
  })

  describe('Enter', () => {
    it('splits a block at the caret', () => {
      const el = rowAt(0)
      typeInto(el, 'hello world')
      setCaretOffset(el, 5)
      press(el, 'Enter')

      const order = flatten(store().workspace, pageId)
      expect(order).toHaveLength(2)
      expect(store().workspace.blocks[order[0]].text).toBe('hello')
      expect(store().workspace.blocks[order[1]].text).toBe(' world')
    })

    it('appends an empty block when Enter lands at the end', () => {
      const el = rowAt(0)
      typeInto(el, 'hello world')
      press(el, 'Enter')
      const order = flatten(store().workspace, pageId)
      expect(store().workspace.blocks[order[0]].text).toBe('hello world')
      expect(store().workspace.blocks[order[1]].text).toBe('')
    })

    it('does not split when Shift is held', () => {
      const el = rowAt(0)
      typeInto(el, 'one line')
      press(el, 'Enter', { shiftKey: true })
      expect(flatten(store().workspace, pageId)).toHaveLength(1)
    })

    it('turns an empty top-level list item back into a paragraph', () => {
      const el = rowAt(0)
      typeInto(el, '-')
      press(el, ' ')
      expect(store().workspace.blocks[firstBlock].type).toBe('bulleted')

      press(rowAt(0), 'Enter')
      // Rather than making a second empty bullet, which is what fingers expect.
      expect(store().workspace.blocks[firstBlock].type).toBe('paragraph')
      expect(flatten(store().workspace, pageId)).toHaveLength(1)
    })
  })

  describe('Markdown shortcuts', () => {
    const cases: Array<[string, string]> = [
      ['# ', 'heading1'],
      ['## ', 'heading2'],
      ['### ', 'heading3'],
      ['- ', 'bulleted'],
      ['1. ', 'numbered'],
      ['[] ', 'todo'],
      ['> ', 'toggle'],
      ['" ', 'quote'],
      ['! ', 'callout'],
    ]

    for (const [prefix, type] of cases) {
      it(`turns "${prefix}" into ${type}`, () => {
        const el = rowAt(0)
        // The user types everything but the trailing space, then presses it -
        // the shortcut fires on the space keydown, before it is inserted.
        typeInto(el, prefix.slice(0, -1))
        press(el, ' ')
        expect(store().workspace.blocks[firstBlock].type).toBe(type)
        // The prefix itself must not survive as text.
        expect(store().workspace.blocks[firstBlock].text).toBe('')
      })
    }

    it('does not fire mid-line', () => {
      const el = rowAt(0)
      typeInto(el, 'a #')
      press(el, ' ')
      expect(store().workspace.blocks[firstBlock].type).toBe('paragraph')
    })

    it('prefers the longer prefix, so "## " is not swallowed by "# "', () => {
      const el = rowAt(0)
      typeInto(el, '##')
      press(el, ' ')
      expect(store().workspace.blocks[firstBlock].type).toBe('heading2')
    })

    it('turns --- into a divider and leaves a paragraph below it', () => {
      typeInto(rowAt(0), '---')
      const order = flatten(store().workspace, pageId)
      expect(store().workspace.blocks[order[0]].type).toBe('divider')
      expect(order).toHaveLength(2)
      expect(store().workspace.blocks[order[1]].type).toBe('paragraph')
    })
  })

  describe('Tab', () => {
    it('indents under the previous sibling and outdents with Shift', () => {
      typeInto(rowAt(0), 'first')
      press(rowAt(0), 'Enter')
      typeInto(rowAt(1), 'second')

      press(rowAt(1), 'Tab')
      const second = flatten(store().workspace, pageId)[1]
      expect(store().workspace.blocks[second].parent).toBe(firstBlock)

      press(rowAt(1), 'Tab', { shiftKey: true })
      expect(store().workspace.blocks[second].parent).toBeNull()
    })
  })

  describe('Backspace at the start of a block', () => {
    it('reverts a styled block to a paragraph before merging anything', () => {
      const el = rowAt(0)
      typeInto(el, '#')
      press(el, ' ')
      expect(store().workspace.blocks[firstBlock].type).toBe('heading1')

      press(rowAt(0), 'Backspace')
      // Backspacing out of a heading must not silently eat the line above it.
      expect(store().workspace.blocks[firstBlock].type).toBe('paragraph')
      expect(flatten(store().workspace, pageId)).toHaveLength(1)
    })
  })

  describe('to-dos', () => {
    it('ticks through the same command the island will use', () => {
      const el = rowAt(0)
      typeInto(el, '[]')
      press(el, ' ')
      typeInto(rowAt(0), 'water the orchard')

      const checkbox = screen.getByRole('checkbox')
      fireEvent.click(checkbox)
      expect(store().workspace.blocks[firstBlock].checked).toBe(true)

      store().undo()
      expect(store().workspace.blocks[firstBlock].checked).toBe(false)
    })
  })

  describe('the slash menu', () => {
    it('opens on / in an empty block and filters as you type', () => {
      const el = rowAt(0)
      el.focus()
      fireEvent.focus(el)
      press(el, '/')
      expect(document.querySelector('.slash')).toBeInTheDocument()

      press(el, 'h')
      press(el, '1')
      const first = document.querySelector('.slash__item[data-active="true"] .slash__label')
      expect(first?.textContent).toBe('Heading 1')
    })

    it('does not open mid-word', () => {
      const el = rowAt(0)
      typeInto(el, 'and/or')
      press(el, '/')
      expect(document.querySelector('.slash')).not.toBeInTheDocument()
    })

    it('applies the picked type', () => {
      const el = rowAt(0)
      el.focus()
      fireEvent.focus(el)
      press(el, '/')
      press(el, 'q')
      const active = document.querySelector<HTMLElement>('.slash__item[data-active="true"]')
      fireEvent.mouseDown(active!)
      expect(store().workspace.blocks[firstBlock].type).toBe('quote')
      expect(document.querySelector('.slash')).not.toBeInTheDocument()
    })

    it('closes on Escape without changing the block', () => {
      const el = rowAt(0)
      el.focus()
      fireEvent.focus(el)
      press(el, '/')
      press(el, 'Escape')
      expect(document.querySelector('.slash')).not.toBeInTheDocument()
      expect(store().workspace.blocks[firstBlock].type).toBe('paragraph')
    })
  })

  describe('inline marks', () => {
    it('applies bold to a selection with the modifier shortcut', () => {
      const el = rowAt(0)
      typeInto(el, 'make me bold')

      const range = document.createRange()
      range.setStart(el.firstChild!, 0)
      range.setEnd(el.firstChild!, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      press(el, 'b', { ctrlKey: true })
      expect(store().workspace.blocks[firstBlock].marks).toEqual([
        { start: 0, end: 4, type: 'bold' },
      ])
    })
  })

  it('renders nesting depth so the CSS can indent it', () => {
    typeInto(rowAt(0), 'parent')
    press(rowAt(0), 'Enter')
    typeInto(rowAt(1), 'child')
    press(rowAt(1), 'Tab')

    const rows = document.querySelectorAll<HTMLElement>('.row')
    expect(rows[0].dataset.depth).toBe('0')
    expect(rows[1].dataset.depth).toBe('1')
  })
})
