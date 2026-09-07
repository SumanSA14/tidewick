import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlockType } from '@/state/blocks'
import { searchBlocks, type BlockSpec } from './blockCatalogue'

/**
 * The slash menu.
 *
 * Keyboard-first: it opens on `/`, filters as you keep typing, and Enter picks
 * the highlighted entry. The mouse works too, but every interaction here has a
 * key, because the workspace half of this product is meant to be usable without
 * ever reaching for a pointer.
 */

export interface SlashMenuProps {
  query: string
  anchor: { x: number; y: number }
  onPick(type: BlockType): void
  onClose(): void
  /** Registers a handler so the editor can forward arrow keys and Enter. */
  registerKeyHandler(handler: (event: KeyboardEvent) => boolean): void
}

export function SlashMenu({ query, anchor, onPick, onClose, registerKeyHandler }: SlashMenuProps) {
  const results = useMemo(() => searchBlocks(query), [query])
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Reset the highlight whenever the result set changes, or the selection
  // silently points past the end of a now-shorter list.
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    registerKeyHandler((event: KeyboardEvent) => {
      if (results.length === 0) {
        if (event.key === 'Escape') { onClose(); return true }
        return false
      }
      switch (event.key) {
        case 'ArrowDown':
          setActive((i) => (i + 1) % results.length)
          return true
        case 'ArrowUp':
          setActive((i) => (i - 1 + results.length) % results.length)
          return true
        case 'Enter':
        case 'Tab':
          onPick(results[Math.min(active, results.length - 1)].type)
          return true
        case 'Escape':
          onClose()
          return true
        default:
          return false
      }
    })
  }, [results, active, onPick, onClose, registerKeyHandler])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (results.length === 0) {
    return (
      <div className="slash" style={{ left: anchor.x, top: anchor.y }} role="listbox" aria-label="Block types">
        <p className="slash__empty">No blocks match &ldquo;{query}&rdquo;</p>
      </div>
    )
  }

  let lastGroup: BlockSpec['group'] | null = null

  return (
    <div className="slash" style={{ left: anchor.x, top: anchor.y }}>
      <ul className="slash__list" ref={listRef} role="listbox" aria-label="Block types">
        {results.map((spec, i) => {
          const showGroup = spec.group !== lastGroup && !query.trim()
          lastGroup = spec.group
          return (
            <li key={spec.type}>
              {showGroup && <p className="slash__group">{spec.group}</p>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className="slash__item"
                onMouseEnter={() => setActive(i)}
                // mousedown, not click: click fires after blur, by which time
                // the editor has already lost the selection we need.
                onMouseDown={(e) => { e.preventDefault(); onPick(spec.type) }}
              >
                <span className="slash__glyph">{spec.glyph}</span>
                <span className="slash__body">
                  <span className="slash__label">{spec.label}</span>
                  <span className="slash__hint">{spec.hint}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
