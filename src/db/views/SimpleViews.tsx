import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { AddRow, SetPropertyValue } from '@/state/databaseCommands'
import { findProperty, readDate, type PropertyDef } from '@/state/database'
import { PropertyCell } from '../PropertyCell'
import { valueOf } from '../query'
import type { ViewProps } from './TableView'

/**
 * List, Gallery and Calendar.
 *
 * Grouped into one file because they are variations on the same three moves -
 * take the query result, choose which properties to show, render a row per id -
 * and splitting them into three modules would be three near-identical
 * scaffolds around a dozen lines of difference each.
 */

// --- List ------------------------------------------------------------------

export function ListView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const pages = useWorkspaceStore((s) => s.workspace.pages)

  // A list is deliberately sparse: the title, and at most two supporting
  // values. Section 6.3 calls for "compact, minimal chrome", and a list that
  // shows every column is just a worse table.
  const extras = view.visibleProperties
    .map((id) => findProperty(database, id))
    .filter((p): p is PropertyDef => p !== undefined && p.type !== 'title')
    .slice(0, 2)

  return (
    <div className="list">
      {result.rows.map((rowId) => {
        const page = pages[rowId]
        if (!page) return null
        return (
          <div className="list__row" key={rowId}>
            <button type="button" className="list__title" onClick={() => onOpenRow(rowId)}>
              {page.title || 'Untitled'}
            </button>
            <div className="list__extras">
              {extras.map((property) => (
                <PropertyCell key={property.id} page={page} property={property} database={database} variant="card" />
              ))}
            </div>
          </div>
        )
      })}
      <button type="button" className="list__add" onClick={() => dispatch(new AddRow(database.id))}>
        + New
      </button>
    </div>
  )
}

// --- Gallery ---------------------------------------------------------------

export function GalleryView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const pages = useWorkspaceStore((s) => s.workspace.pages)
  const state = useWorkspaceStore((s) => s.workspace)

  const cover = view.coverProperty ? findProperty(database, view.coverProperty) : undefined
  const fields = view.visibleProperties
    .map((id) => findProperty(database, id))
    .filter((p): p is PropertyDef => p !== undefined && p.type !== 'title' && p.id !== view.coverProperty)
    .slice(0, 4)

  return (
    <div className="gallery">
      {result.rows.map((rowId) => {
        const page = pages[rowId]
        if (!page) return null
        const coverValue = cover ? valueOf(state, page, cover) : null
        const coverUrl = Array.isArray(coverValue)
          ? (coverValue as Array<{ url?: string }>)[0]?.url
          : undefined
        return (
          <article className="gallery__card" key={rowId}>
            <button type="button" className="gallery__cover" onClick={() => onOpenRow(rowId)}>
              {coverUrl
                ? <img src={coverUrl} alt="" />
                : <span className="gallery__blank" aria-hidden="true" />}
            </button>
            <button type="button" className="gallery__title" onClick={() => onOpenRow(rowId)}>
              {page.title || 'Untitled'}
            </button>
            <div className="gallery__fields">
              {fields.map((property) => (
                <PropertyCell key={property.id} page={page} property={property} database={database} variant="card" />
              ))}
            </div>
          </article>
        )
      })}
      <button type="button" className="gallery__add" onClick={() => dispatch(new AddRow(database.id))}>
        + New
      </button>
    </div>
  )
}

// --- Calendar --------------------------------------------------------------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function CalendarView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const state = useWorkspaceStore((s) => s.workspace)
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [dragging, setDragging] = useState<string | null>(null)

  const dateProperty = view.dateProperty ? findProperty(database, view.dateProperty) : undefined

  const cells = useMemo(() => buildMonth(cursor), [cursor])

  const byDay = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!dateProperty) return map
    for (const rowId of result.rows) {
      const page = state.pages[rowId]
      if (!page) continue
      const date = readDate(valueOf(state, page, dateProperty))
      if (!date) continue
      const key = dayKey(new Date(Date.parse(date.start)))
      const list = map.get(key)
      if (list) list.push(rowId)
      else map.set(key, [rowId])
    }
    return map
  }, [result.rows, state, dateProperty])

  if (!dateProperty) {
    return <p className="calendar__hint">A calendar needs a date property. Add one, then choose it here.</p>
  }

  /** Dropping a card on a day writes the new date back to the property. */
  const dropOn = (day: Date) => {
    if (!dragging) return
    const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
    dispatch(new SetPropertyValue(
      dragging,
      dateProperty.id,
      { start: iso, hasTime: false },
      `Reschedule to ${iso}`,
    ))
    setDragging(null)
  }

  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(cursor)

  return (
    <div className="calendar">
      <header className="calendar__bar">
        <button type="button" onClick={() => setCursor(addMonths(cursor, -1))} aria-label="Previous month">‹</button>
        <strong>{monthLabel}</strong>
        <button type="button" onClick={() => setCursor(addMonths(cursor, 1))} aria-label="Next month">›</button>
        <button type="button" className="calendar__today" onClick={() => setCursor(startOfMonth(new Date()))}>Today</button>
      </header>

      <div className="calendar__weekdays" aria-hidden="true">
        {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
      </div>

      <div className="calendar__grid">
        {cells.map((day) => {
          const key = dayKey(day)
          const rows = byDay.get(key) ?? []
          const outside = day.getMonth() !== cursor.getMonth()
          return (
            <div
              key={key}
              className={`calendar__day${outside ? ' is-outside' : ''}${isToday(day) ? ' is-today' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); dropOn(day) }}
            >
              <span className="calendar__date">{day.getDate()}</span>
              {rows.map((rowId) => (
                <button
                  key={rowId}
                  type="button"
                  className="calendar__event"
                  draggable
                  onDragStart={() => setDragging(rowId)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => onOpenRow(rowId)}
                >
                  {state.pages[rowId]?.title || 'Untitled'}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- date helpers ----------------------------------------------------------

function pad(n: number): string { return String(n).padStart(2, '0') }

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1)
}

function isToday(d: Date): boolean {
  return dayKey(d) === dayKey(new Date())
}

/**
 * Six weeks of cells, Monday-first, padded from the previous and next months.
 *
 * Always six rows rather than five or six, so the grid does not change height
 * as you page through months - a calendar that resizes under the cursor is
 * unpleasant to click around in.
 */
function buildMonth(cursor: Date): Date[] {
  const first = startOfMonth(cursor)
  // getDay() is Sunday-first; shift so Monday is 0.
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  return Array.from({ length: 42 }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}
