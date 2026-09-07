import { useCallback, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { AddRow, DeleteRow, UpdateView, toggleSort } from '@/state/databaseCommands'
import { findProperty, type Database, type View } from '@/state/database'
import { PropertyCell } from '../PropertyCell'
import type { QueryResult } from '../query'

/**
 * The Table view.
 *
 * Windowed. Section 6.3 asks for 500 rows inside a 16 ms frame, and the query
 * itself is a rounding error - it is mounting five hundred rows of a dozen
 * interactive cells that blows the budget. Only the visible slice plus a small
 * overscan is rendered, with spacer rows holding the scroll height, so cost is
 * proportional to the viewport rather than to the data.
 */

export interface ViewProps {
  database: Database
  view: View
  result: QueryResult
  onOpenRow(rowId: string): void
}

/** Fixed row height, so the window can be computed without measuring. */
const ROW_HEIGHT = 34
const OVERSCAN = 8
const MIN_COLUMN = 90
const DEFAULT_COLUMN = 180

export function TableView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const pages = useWorkspaceStore((s) => s.workspace.pages)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)

  const properties = useMemo(
    () => view.visibleProperties.map((id) => findProperty(database, id)).filter(Boolean),
    [view.visibleProperties, database],
  ) as NonNullable<ReturnType<typeof findProperty>>[]

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
    setViewportHeight(e.currentTarget.clientHeight)
  }, [])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const last = Math.min(result.rows.length, first + visibleCount)
  const slice = result.rows.slice(first, last)

  const widthOf = (id: string) => view.columnWidths?.[id] ?? DEFAULT_COLUMN

  const setWidth = (id: string, width: number) => {
    dispatch(new UpdateView(database.id, view.id, {
      columnWidths: { ...view.columnWidths, [id]: Math.max(MIN_COLUMN, Math.round(width)) },
    }, 'Resize column'))
  }

  const sortDirection = (id: string) => view.sorts.find((s) => s.propertyId === id)?.direction

  return (
    <div className="table" role="table" aria-rowcount={result.rows.length}>
      <div className="table__head" role="row">
        {properties.map((property, index) => (
          <ColumnHeader
            key={property.id}
            name={property.name}
            type={property.type}
            width={widthOf(property.id)}
            frozen={index === 0}
            direction={sortDirection(property.id)}
            onSort={() => dispatch(new UpdateView(database.id, view.id, {
              sorts: toggleSort(view.sorts, property.id),
            }, `Sort by ${property.name}`))}
            onResize={(w) => setWidth(property.id, w)}
          />
        ))}
        <div className="table__spacer" />
      </div>

      <div className="table__body" ref={scrollRef} onScroll={onScroll} role="rowgroup">
        {/* Spacers carry the scroll height for the rows that are not mounted. */}
        <div style={{ height: first * ROW_HEIGHT }} aria-hidden="true" />

        {slice.map((rowId, i) => {
          const page = pages[rowId]
          if (!page) return null
          return (
            <div className="table__row" role="row" key={rowId} aria-rowindex={first + i + 1}>
              {properties.map((property, index) => (
                <div
                  className={`table__cell${index === 0 ? ' table__cell--title' : ''}`}
                  role="cell"
                  style={{ width: widthOf(property.id) }}
                  key={property.id}
                >
                  <PropertyCell page={page} property={property} database={database} />
                  {index === 0 && (
                    <button
                      type="button"
                      className="table__open"
                      onClick={() => onOpenRow(rowId)}
                      aria-label={`Open ${page.title || 'Untitled'}`}
                    >
                      Open
                    </button>
                  )}
                </div>
              ))}
              <div className="table__rowActions">
                <button
                  type="button"
                  className="table__delete"
                  onClick={() => dispatch(new DeleteRow(database.id, rowId))}
                  aria-label={`Remove ${page.title || 'Untitled'}`}
                >
                  &times;
                </button>
              </div>
            </div>
          )
        })}

        <div style={{ height: Math.max(0, (result.rows.length - last) * ROW_HEIGHT) }} aria-hidden="true" />

        <button
          type="button"
          className="table__add"
          onClick={() => dispatch(new AddRow(database.id))}
        >
          + New
        </button>
      </div>

      <footer className="table__foot">
        {result.rows.length === result.total
          ? `${result.total} row${result.total === 1 ? '' : 's'}`
          : `${result.rows.length} of ${result.total}`}
      </footer>
    </div>
  )
}

function ColumnHeader({
  name, type, width, frozen, direction, onSort, onResize,
}: {
  name: string
  type: string
  width: number
  frozen: boolean
  direction?: 'asc' | 'desc'
  onSort(): void
  onResize(width: number): void
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    startRef.current = { x: e.clientX, width }
    const move = (ev: PointerEvent) => {
      if (!startRef.current) return
      onResize(startRef.current.width + (ev.clientX - startRef.current.x))
    }
    const up = () => {
      startRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`table__th${frozen ? ' table__th--frozen' : ''}`}
      style={{ width }}
      role="columnheader"
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button type="button" className="table__sort" onClick={onSort} title={`Sort by ${name}`}>
        <span className="table__name">{name}</span>
        <span className="table__type">{typeGlyph(type)}</span>
        {direction && <span className="table__arrow">{direction === 'asc' ? '↑' : '↓'}</span>}
      </button>
      <div
        className="table__grip"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${name}`}
      />
    </div>
  )
}

/** Text glyphs rather than an icon font, because this ships offline. */
function typeGlyph(type: string): string {
  switch (type) {
    case 'title': return 'Aa'
    case 'text': return '≡'
    case 'number': return '#'
    case 'select': return '◦'
    case 'multiSelect': return '◈'
    case 'status': return '◐'
    case 'date': return '▤'
    case 'checkbox': return '☑'
    case 'url': return '↗'
    case 'email': return '@'
    case 'phone': return '☏'
    case 'files': return '❐'
    case 'relation': return '⇄'
    case 'rollup': return 'Σ'
    case 'formula': return 'ƒ'
    case 'createdTime': return '⊕'
    case 'lastEditedTime': return '⊙'
    default: return ''
  }
}
