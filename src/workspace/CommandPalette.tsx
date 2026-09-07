import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceState } from '@/state/types'
import './palette.css'

/**
 * The command palette. Ctrl+K, or Cmd+K.
 *
 * One box that finds anything: pages by title, rows by title, databases by
 * name, text inside blocks, and the handful of actions that have no other
 * keyboard home. Section 6.5 asks for a palette and full-text search; they are
 * the same surface here because a person looking for "two sum" does not know
 * or care whether it is a page title, a row, or a sentence in a note.
 *
 * Search is a plain scan over the workspace. There is no index, because a
 * local-first workspace has a few thousand blocks at most and a substring scan
 * over that finishes in a millisecond - an index would be state to keep in
 * sync, and Section 2 has an opinion about that.
 *
 * Ranking is deliberate and simple: a title that *starts* with the query beats
 * a title that contains it, which beats a body match; recently edited wins
 * ties. No fuzzy matching. Fuzzy matching feels clever for a week and then
 * surfaces "Seasons" when you typed "Two Sum".
 */

export type PaletteTarget =
  | { kind: 'page'; id: string }
  | { kind: 'database'; id: string }
  | { kind: 'action'; id: string }

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  keywords?: string[]
  run(): void
}

export interface CommandPaletteProps {
  workspace: WorkspaceState
  actions: PaletteAction[]
  open: boolean
  onClose(): void
  onPick(target: PaletteTarget): void
}

interface Hit {
  target: PaletteTarget
  title: string
  /** Where it was found, for the secondary line. */
  detail: string
  /** Lower sorts first. */
  rank: number
  recency: number
}

const MAX_RESULTS = 12

export function search(workspace: WorkspaceState, query: string, actions: PaletteAction[]): Hit[] {
  const q = query.trim().toLowerCase()
  const hits: Hit[] = []

  // With nothing typed, recent pages lead and the actions follow: the palette
  // doubles as the menu the workspace otherwise does not have, but the thing
  // most people open it for is the page they were just on.
  for (const action of actions) {
    const label = action.label.toLowerCase()
    const words = [label, ...(action.keywords ?? []).map((k) => k.toLowerCase())]
    const match = q === '' ? 0 : words.some((w) => w.startsWith(q)) ? 0 : words.some((w) => w.includes(q)) ? 1 : -1
    if (match < 0) continue
    hits.push({
      target: { kind: 'action', id: action.id },
      title: action.label,
      detail: action.hint ?? 'Action',
      rank: q === '' ? 3 : match,
      recency: 0,
    })
  }

  for (const database of Object.values(workspace.databases)) {
    const name = database.name.toLowerCase()
    const match = q === '' ? 2 : rankOf(name, q)
    if (match < 0) continue
    hits.push({
      target: { kind: 'database', id: database.id },
      title: database.name || 'Untitled database',
      detail: `Database · ${database.rows.length} ${database.rows.length === 1 ? 'row' : 'rows'}`,
      rank: match,
      recency: database.createdAt,
    })
  }

  for (const page of Object.values(workspace.pages)) {
    if (page.trashed) continue
    const title = (page.title || 'Untitled').toLowerCase()
    let match = q === '' ? 2 : rankOf(title, q)
    let detail = page.databaseId
      ? `Row in ${workspace.databases[page.databaseId]?.name ?? 'a database'}`
      : 'Page'

    // Body text: only when the title did not already match, and only the
    // first sentence that does, as the secondary line.
    if (match < 0 && q.length >= 2) {
      for (const blockId of page.children) {
        const found = findInBlock(workspace, blockId, q)
        if (found) {
          match = 2
          detail = found
          break
        }
      }
    }
    if (match < 0) continue
    hits.push({
      target: { kind: 'page', id: page.id },
      title: page.title || 'Untitled',
      detail,
      rank: match,
      recency: page.updatedAt,
    })
  }

  hits.sort((a, b) => a.rank - b.rank || b.recency - a.recency)
  return hits.slice(0, MAX_RESULTS)
}

/** 0 starts-with, 1 contains, -1 no match. */
function rankOf(text: string, q: string): number {
  if (text.startsWith(q)) return 0
  if (text.includes(q)) return 1
  return -1
}

/** Depth-first through a block and its children for the first line containing `q`. */
function findInBlock(workspace: WorkspaceState, blockId: string, q: string): string | null {
  const block = workspace.blocks[blockId]
  if (!block) return null
  const text = block.text
  const at = text.toLowerCase().indexOf(q)
  if (at >= 0) {
    // A window around the match, so the user sees why it was found.
    const start = Math.max(0, at - 28)
    const end = Math.min(text.length, at + q.length + 44)
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
  }
  for (const child of block.children) {
    const found = findInBlock(workspace, child, q)
    if (found) return found
  }
  return null
}

export function CommandPalette({ workspace, actions, open, onClose, onPick }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const hits = useMemo(() => (open ? search(workspace, query, actions) : []), [workspace, query, actions, open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    // Next frame, so the element exists.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, hits.length - 1)))
  }, [hits.length])

  useEffect(() => {
    // Keep the highlighted row in view as the arrow keys move it.
    const item = listRef.current?.children[cursor] as HTMLElement | undefined
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const pick = (hit: Hit) => {
    if (hit.target.kind === 'action') {
      actions.find((a) => a.id === hit.target.id)?.run()
    } else {
      onPick(hit.target)
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (hits[cursor]) pick(hits[cursor]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="palette__scrim" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-label="Search and commands"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder="Find a page, a row, a database, or something you wrote…"
          onChange={(e) => { setQuery(e.target.value); setCursor(0) }}
          onKeyDown={onKeyDown}
          aria-controls="palette-results"
          aria-activedescendant={hits[cursor] ? `palette-hit-${cursor}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <ul className="palette__list" id="palette-results" role="listbox" ref={listRef}>
          {hits.length === 0 && (
            <li className="palette__empty">
              {query ? 'Nothing on the isle matches that.' : 'Start typing.'}
            </li>
          )}
          {hits.map((hit, i) => (
            <li
              key={`${hit.target.kind}:${hit.target.id}`}
              id={`palette-hit-${i}`}
              role="option"
              aria-selected={i === cursor}
              className={`palette__hit${i === cursor ? ' is-active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(hit) }}
            >
              <span className={`palette__kind palette__kind--${hit.target.kind}`} aria-hidden="true">
                {hit.target.kind === 'page' ? '¶' : hit.target.kind === 'database' ? '▦' : '›'}
              </span>
              <span className="palette__text">
                <span className="palette__title">{hit.title}</span>
                <span className="palette__detail">{hit.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="palette__foot" aria-hidden="true">
          <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close
        </p>
      </div>
    </div>
  )
}
