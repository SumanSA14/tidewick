import { useEffect, useLayoutEffect, useRef, memo } from 'react'
import type { Block } from '@/state/blocks'
import { marksToHtml, readInline, getSelectionRange, setCaretOffset, toggleMark } from './inline'
import { specFor } from './blockCatalogue'

/**
 * One block, rendered as a contenteditable line.
 *
 * The hard part of hand-writing an editor is not the typing, it is keeping
 * React and contenteditable from fighting. React wants to own the DOM; the
 * browser is already writing into it as the user types. Re-rendering on every
 * keystroke destroys the caret.
 *
 * The rule here: React never re-renders the *content* of a focused block.
 * `innerHTML` is set imperatively, and only when the incoming text differs from
 * what was last written out - so external changes (undo, a command dispatched
 * from the island) land correctly, while ordinary typing leaves the DOM alone.
 */

export interface BlockRowProps {
  block: Block
  depth: number
  ordinal: number
  focused: boolean
  onInput(blockId: string, text: string, marks: Block['marks']): void
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>, block: Block): void
  onFocus(blockId: string): void
  onToggleCheck(blockId: string): void
  onToggleCollapse(blockId: string): void
  /** Caret offset to restore after an external change, or null to leave alone. */
  caretRequest: number | null
  onCaretApplied(): void
}

export const BlockRow = memo(function BlockRow({
  block, depth, ordinal, focused,
  onInput, onKeyDown, onFocus, onToggleCheck, onToggleCollapse,
  caretRequest, onCaretApplied,
}: BlockRowProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const lastWritten = useRef<string>('')
  const spec = specFor(block.type)

  // Write content into the DOM only when it actually differs. Comparing the
  // rendered HTML rather than the text catches mark-only changes too.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const html = marksToHtml(block.text, block.marks)
    if (html === lastWritten.current) return
    lastWritten.current = html
    el.innerHTML = html
  }, [block.text, block.marks])

  useEffect(() => {
    const el = ref.current
    if (!el || caretRequest === null) return
    el.focus()
    setCaretOffset(el, caretRequest)
    onCaretApplied()
  }, [caretRequest, onCaretApplied])

  useEffect(() => {
    const el = ref.current
    if (!el || !focused) return
    if (document.activeElement !== el && caretRequest === null) el.focus()
  }, [focused, caretRequest])

  if (block.type === 'divider') {
    return (
      <div className="row row--divider" data-depth={depth} data-block-id={block.id}>
        <hr />
      </div>
    )
  }

  const handleInput = () => {
    const el = ref.current
    if (!el) return
    const { text, marks } = readInline(el)
    lastWritten.current = marksToHtml(text, marks)
    onInput(block.id, text, marks)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return

    // Intercept the native formatting shortcuts. Left alone, the browser
    // inserts its own <b>/<i> markup, which readInline would then have to
    // interpret - it works, but the store ends up shaped by whatever the
    // browser felt like emitting rather than by us.
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey) {
      const type =
        event.key.toLowerCase() === 'b' ? 'bold'
        : event.key.toLowerCase() === 'i' ? 'italic'
        : event.key.toLowerCase() === 'u' ? 'underline'
        : event.key.toLowerCase() === 'e' ? 'code'
        : null
      if (type) {
        event.preventDefault()
        const range = getSelectionRange(el)
        if (!range || range.end === range.start) return
        const next = toggleMark(block.marks, block.text.length, range.start, range.end, type)
        lastWritten.current = marksToHtml(block.text, next)
        el.innerHTML = lastWritten.current
        setCaretOffset(el, range.end)
        onInput(block.id, block.text, next)
        return
      }
    }
    onKeyDown(event, block)
  }

  const content = (
    <div
      ref={ref}
      className="row__text"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="false"
      aria-label={`${spec.label} block`}
      data-placeholder={placeholderFor(block, depth)}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onFocus={() => onFocus(block.id)}
      spellCheck
    />
  )

  return (
    <div
      className={`row row--${block.type}${block.checked ? ' row--done' : ''}`}
      data-depth={depth}
      data-block-id={block.id}
      style={{ ['--depth' as string]: depth }}
    >
      <div className="row__gutter" aria-hidden={block.type !== 'todo' && block.type !== 'toggle'}>
        {block.type === 'bulleted' && <span className="marker marker--bullet">•</span>}
        {block.type === 'numbered' && <span className="marker marker--number">{ordinal}.</span>}
        {block.type === 'todo' && (
          <input
            type="checkbox"
            className="marker marker--check"
            checked={block.checked ?? false}
            onChange={() => onToggleCheck(block.id)}
            aria-label={block.text ? `Complete: ${block.text}` : 'Complete this task'}
          />
        )}
        {block.type === 'toggle' && (
          <button
            type="button"
            className={`marker marker--toggle${block.collapsed ? ' is-collapsed' : ''}`}
            onClick={() => onToggleCollapse(block.id)}
            aria-expanded={!block.collapsed}
            aria-label={block.collapsed ? 'Expand' : 'Collapse'}
          >
            ▸
          </button>
        )}
        {block.type === 'callout' && <span className="marker marker--callout">◆</span>}
      </div>
      {content}
    </div>
  )
})

/**
 * Placeholders appear only on the focused empty block, except for the very
 * first one. A page of grey hint text on every empty line is noise, and this
 * half of the product is meant to be calm.
 */
function placeholderFor(block: Block, depth: number): string {
  if (block.text.length > 0) return ''
  switch (block.type) {
    case 'heading1': return 'Heading'
    case 'heading2': return 'Heading'
    case 'heading3': return 'Heading'
    case 'todo': return 'To-do'
    case 'quote': return 'Quote'
    case 'callout': return 'Callout'
    case 'code': return 'Code'
    case 'toggle': return 'Toggle'
    case 'bulleted':
    case 'numbered': return 'List item'
    default: return depth === 0 ? "Write, or press '/' for blocks" : ''
  }
}
