import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { flatten, depthOf, orderedIndex, type Block, type BlockType, type Mark } from '@/state/blocks'
import {
  InsertBlock, DeleteBlock, SetBlockText, SetBlockType, SplitBlock,
  MergeIntoPrevious, IndentBlock, OutdentBlock, ToggleTodo, ToggleCollapsed,
  SetPageTitle,
} from '@/state/blockCommands'
import { matchMarkdown } from './blockCatalogue'
import { BlockRow } from './BlockRow'
import { SlashMenu } from './SlashMenu'
import { getCaretOffset } from './inline'

/**
 * The block editor.
 *
 * Everything that changes state goes through `dispatch(command)` - there is no
 * second path, and the island in Phase 4 will read the result without any sync
 * code. The editor's own job is only to decide *which* command a keystroke
 * means, and to put the caret back afterwards.
 *
 * Caret restoration is explicit rather than inferred. After a structural change
 * the block the caret belonged to may not exist any more (a merge) or may not
 * be the one the user should land in (a split), so the command handler names
 * the target block and offset and the row applies it once.
 */

export interface BlockEditorProps {
  pageId: string
}

/** Consecutive keystrokes inside this window fold into one undo step. */
const TYPING_COALESCE_MS = 700

export function BlockEditor({ pageId }: BlockEditorProps) {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const amend = useWorkspaceStore((s) => s.amend)

  const page = workspace.pages[pageId]
  const visible = useMemo(() => flatten(workspace, pageId), [workspace, pageId])

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [caret, setCaret] = useState<{ blockId: string; offset: number } | null>(null)
  const [slash, setSlash] = useState<{ blockId: string; query: string; anchor: { x: number; y: number } } | null>(null)
  const slashKeyHandler = useRef<((e: KeyboardEvent) => boolean) | null>(null)

  // Typing coalescence. Holding the live command lets a burst of keystrokes
  // absorb into one undo step instead of one per character.
  const typing = useRef<{ blockId: string; command: SetBlockText; at: number } | null>(null)

  const requestCaret = useCallback((blockId: string, offset: number) => {
    setCaret({ blockId, offset })
    setFocusedId(blockId)
  }, [])

  const clearCaret = useCallback(() => setCaret(null), [])

  // --- text input ----------------------------------------------------------

  const handleInput = useCallback((blockId: string, text: string, marks: Mark[]) => {
    const now = Date.now()
    const live = typing.current
    if (live && live.blockId === blockId && now - live.at < TYPING_COALESCE_MS) {
      // Fold into the command already on the stack, then re-run it so the
      // store reflects the newest text. Because SetBlockText captured its
      // before-state on first apply, undo still reaches the start of the burst.
      live.command.absorb(text, marks)
      live.at = now
      amend(live.command)
      return
    }
    const command = new SetBlockText(blockId, text, marks)
    typing.current = { blockId, command, at: now }
    dispatch(command)
  }, [dispatch, amend])

  // --- key routing ---------------------------------------------------------

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, block: Block) => {
    // The slash menu gets first refusal on navigation keys.
    if (slash && slashKeyHandler.current?.(event.nativeEvent)) {
      event.preventDefault()
      return
    }

    const el = event.currentTarget
    const offset = getCaretOffset(el) ?? block.text.length

    if (event.key === '/' && block.text.length === 0) {
      const rect = el.getBoundingClientRect()
      setSlash({ blockId: block.id, query: '', anchor: { x: rect.left, y: rect.bottom + 6 } })
      return
    }

    if (slash && slash.blockId === block.id) {
      if (event.key === 'Backspace' && slash.query.length === 0) setSlash(null)
      else if (event.key.length === 1) setSlash({ ...slash, query: slash.query + event.key })
      else if (event.key === 'Backspace') setSlash({ ...slash, query: slash.query.slice(0, -1) })
    }

    switch (event.key) {
      case 'Enter': {
        if (event.shiftKey) return
        event.preventDefault()
        typing.current = null

        // Enter on an empty nested list item outdents rather than making
        // another empty item, which is what every editor does and what fingers
        // expect.
        const isList = block.type === 'bulleted' || block.type === 'numbered' || block.type === 'todo'
        if (isList && block.text.length === 0) {
          if (block.parent) {
            dispatch(new OutdentBlock(block.id))
          } else {
            dispatch(new SetBlockType(block.id, 'paragraph'))
          }
          requestCaret(block.id, 0)
          return
        }

        const split = new SplitBlock(block.id, offset)
        dispatch(split)
        requestCaret(split.newId, 0)
        return
      }

      case 'Backspace': {
        if (offset !== 0) return
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return
        event.preventDefault()
        typing.current = null

        // A styled block first reverts to a paragraph. Only a plain, top-level
        // paragraph merges upward - so backspacing out of a heading does not
        // silently eat the line above it.
        if (block.type !== 'paragraph') {
          dispatch(new SetBlockType(block.id, 'paragraph'))
          requestCaret(block.id, 0)
          return
        }
        if (block.parent) {
          dispatch(new OutdentBlock(block.id))
          requestCaret(block.id, 0)
          return
        }

        const index = visible.indexOf(block.id)
        const previousId = index > 0 ? visible[index - 1] : null
        const previous = previousId ? workspace.blocks[previousId] : null
        if (!previous) return

        if (previous.type === 'divider') {
          dispatch(new DeleteBlock(previous.id))
          requestCaret(block.id, 0)
          return
        }
        const at = previous.text.length
        dispatch(new MergeIntoPrevious(block.id, previous.id))
        requestCaret(previous.id, at)
        return
      }

      case 'Tab': {
        event.preventDefault()
        typing.current = null
        dispatch(event.shiftKey ? new OutdentBlock(block.id) : new IndentBlock(block.id))
        requestCaret(block.id, offset)
        return
      }

      case 'ArrowUp': {
        if (offset !== 0) return
        const index = visible.indexOf(block.id)
        if (index <= 0) return
        event.preventDefault()
        const target = workspace.blocks[visible[index - 1]]
        requestCaret(visible[index - 1], target?.text.length ?? 0)
        return
      }

      case 'ArrowDown': {
        if (offset !== block.text.length) return
        const index = visible.indexOf(block.id)
        if (index === -1 || index >= visible.length - 1) return
        event.preventDefault()
        requestCaret(visible[index + 1], 0)
        return
      }

      case ' ': {
        // Markdown shortcuts fire on space, evaluated against the text that
        // *will* exist - the keystroke has not been applied yet.
        const prefix = block.text.slice(0, offset) + ' '
        const match = matchMarkdown(prefix)
        if (!match || block.type !== 'paragraph') return
        event.preventDefault()
        typing.current = null
        const rest = block.text.slice(match.consumed)
        dispatch(new SetBlockType(block.id, match.type))
        dispatch(new SetBlockText(block.id, rest, []))
        requestCaret(block.id, 0)
        return
      }

      default:
        return
    }
  }, [dispatch, slash, visible, workspace, requestCaret])

  // Markdown shortcuts that end in a non-space character, checked after input.
  useEffect(() => {
    if (!focusedId) return
    const block = workspace.blocks[focusedId]
    if (!block || block.type !== 'paragraph') return
    if (block.text === '---' || block.text === '```') {
      const type: BlockType = block.text === '---' ? 'divider' : 'code'
      typing.current = null
      dispatch(new SetBlockText(block.id, '', []))
      dispatch(new SetBlockType(block.id, type))
      if (type === 'divider') {
        const insert = new InsertBlock(pageId, block.id)
        dispatch(insert)
        requestCaret(insert.blockId, 0)
      } else {
        requestCaret(block.id, 0)
      }
    }
  }, [workspace, focusedId, dispatch, pageId, requestCaret])

  const handlePickBlockType = useCallback((type: BlockType) => {
    if (!slash) return
    const blockId = slash.blockId
    setSlash(null)
    typing.current = null
    if (type === 'divider') {
      dispatch(new SetBlockType(blockId, 'divider'))
      const insert = new InsertBlock(pageId, blockId)
      dispatch(insert)
      requestCaret(insert.blockId, 0)
      return
    }
    dispatch(new SetBlockType(blockId, type))
    requestCaret(blockId, 0)
  }, [slash, dispatch, pageId, requestCaret])

  /** Clicking empty space below the last block appends a paragraph. */
  const handleTrailingClick = useCallback(() => {
    const last = visible.at(-1)
    const lastBlock = last ? workspace.blocks[last] : null
    if (lastBlock && lastBlock.type === 'paragraph' && lastBlock.text.length === 0) {
      requestCaret(lastBlock.id, 0)
      return
    }
    const rootChildren = page?.children ?? []
    const after = rootChildren.at(-1) ?? null
    const insert = new InsertBlock(pageId, after)
    dispatch(insert)
    requestCaret(insert.blockId, 0)
  }, [visible, workspace, page, pageId, dispatch, requestCaret])

  if (!page) {
    return <p className="editor__missing">That page is not here any more.</p>
  }

  return (
    <div className="editor">
      <input
        className="editor__title"
        value={page.title}
        placeholder="Untitled"
        aria-label="Page title"
        onChange={(e) => dispatch(new SetPageTitle(pageId, e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === 'ArrowDown' && page.children.length)) {
            e.preventDefault()
            const first = page.children[0]
            if (first) requestCaret(first, 0)
          }
        }}
      />

      <div className="editor__blocks">
        {visible.map((id) => {
          const block = workspace.blocks[id]
          if (!block) return null
          return (
            <BlockRow
              key={id}
              block={block}
              depth={depthOf(workspace, id)}
              ordinal={block.type === 'numbered' ? orderedIndex(workspace, id) : 0}
              focused={focusedId === id}
              caretRequest={caret?.blockId === id ? caret.offset : null}
              onCaretApplied={clearCaret}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={setFocusedId}
              onToggleCheck={(blockId) => dispatch(new ToggleTodo(blockId))}
              onToggleCollapse={(blockId) => dispatch(new ToggleCollapsed(blockId))}
            />
          )
        })}
      </div>

      <div className="editor__trailing" onClick={handleTrailingClick} aria-hidden="true" />

      {slash && (
        <SlashMenu
          query={slash.query}
          anchor={slash.anchor}
          onPick={handlePickBlockType}
          onClose={() => setSlash(null)}
          registerKeyHandler={(h) => { slashKeyHandler.current = h }}
        />
      )}
    </div>
  )
}
