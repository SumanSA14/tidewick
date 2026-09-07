import { useCallback, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { SetPropertyValue } from '@/state/databaseCommands'
import { findProperty, readDate, readStringArray, type DateValue } from '@/state/database'
import { valueOf } from '../query'
import type { ViewProps } from './TableView'

/**
 * The Timeline, which is the island seen in profile.
 *
 * Section 4 says the Gantt chart and the isle's side elevation are the same
 * projection of the same data, and that is literally true here: both read a
 * due date and turn it into a distance from today. Dragging a bar writes the
 * date back through the same command the cell editor uses, so the plant slides
 * up or down the slope while you are still holding the mouse.
 *
 * Days are the unit throughout. Pixels-per-day is the only zoom parameter, and
 * every position is `daysFromStart * pxPerDay` - which keeps the maths honest
 * when the range spans a quarter.
 */

const MS_PER_DAY = 86_400_000

const ZOOMS = [
  { label: 'Day', pxPerDay: 44 },
  { label: 'Week', pxPerDay: 16 },
  { label: 'Month', pxPerDay: 6 },
  { label: 'Quarter', pxPerDay: 2.4 },
]

const ROW_HEIGHT = 30
const LABEL_WIDTH = 170

interface Bar {
  rowId: string
  title: string
  startDay: number
  endDay: number
  lane: number
}

export function TimelineView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const state = useWorkspaceStore((s) => s.workspace)
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<{ rowId: string; mode: 'move' | 'start' | 'end'; originX: number; startDay: number; endDay: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const pxPerDay = ZOOMS[zoom].pxPerDay
  const dateProperty = view.dateProperty ? findProperty(database, view.dateProperty) : undefined
  const relationProperty = database.properties.find((p) => p.type === 'relation')

  // Anchor the axis on today, so "now" is always a findable landmark.
  const origin = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }, [])

  const bars = useMemo<Bar[]>(() => {
    if (!dateProperty) return []
    const out: Bar[] = []
    let lane = 0
    for (const rowId of result.rows) {
      const page = state.pages[rowId]
      if (!page) continue
      const date = readDate(valueOf(state, page, dateProperty))
      if (!date) continue
      const startMs = Date.parse(date.start)
      if (!Number.isFinite(startMs)) continue
      const endMs = date.end ? Date.parse(date.end) : startMs
      out.push({
        rowId,
        title: page.title || 'Untitled',
        startDay: Math.round((startOfDay(startMs) - origin) / MS_PER_DAY),
        // A single-day task still needs a bar wide enough to grab.
        endDay: Math.round((startOfDay(Number.isFinite(endMs) ? endMs : startMs) - origin) / MS_PER_DAY),
        lane: lane++,
      })
    }
    return out
  }, [result.rows, state, dateProperty, origin])

  const span = useMemo(() => {
    if (bars.length === 0) return { from: -14, to: 60 }
    const from = Math.min(-7, ...bars.map((b) => b.startDay)) - 7
    const to = Math.max(30, ...bars.map((b) => b.endDay)) + 14
    return { from, to }
  }, [bars])

  const width = (span.to - span.from) * pxPerDay
  const xOf = (day: number) => (day - span.from) * pxPerDay

  const commit = useCallback((rowId: string, startDay: number, endDay: number) => {
    if (!dateProperty) return
    const start = new Date(origin + startDay * MS_PER_DAY)
    const end = new Date(origin + endDay * MS_PER_DAY)
    const value: DateValue = {
      start: isoDay(start),
      end: endDay > startDay ? isoDay(end) : undefined,
      hasTime: false,
    }
    dispatch(new SetPropertyValue(rowId, dateProperty.id, value, 'Reschedule'))
  }, [dispatch, dateProperty, origin])

  const onPointerDown = (e: React.PointerEvent, bar: Bar, mode: 'move' | 'start' | 'end') => {
    e.preventDefault()
    e.stopPropagation()
    const originX = e.clientX
    setDrag({ rowId: bar.rowId, mode, originX, startDay: bar.startDay, endDay: bar.endDay })

    const move = (ev: PointerEvent) => {
      const deltaDays = Math.round((ev.clientX - originX) / pxPerDay)
      if (deltaDays === 0) return
      let start = bar.startDay
      let end = bar.endDay
      if (mode === 'move') { start += deltaDays; end += deltaDays }
      else if (mode === 'start') start = Math.min(bar.endDay, bar.startDay + deltaDays)
      else end = Math.max(bar.startDay, bar.endDay + deltaDays)
      // Committing during the drag rather than on release is what makes the
      // plant move up the slope live, which is the Phase 5 acceptance test.
      commit(bar.rowId, start, end)
    }
    const up = () => {
      setDrag(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!dateProperty) {
    return (
      <p className="calendar__hint">
        A timeline needs a date property. Add one, then choose it in Sort &amp; group.
      </p>
    )
  }

  const laneOf = new Map(bars.map((b) => [b.rowId, b.lane]))

  return (
    <div className="timeline">
      <header className="timeline__bar">
        <span className="timeline__zoomLabel">Zoom</span>
        {ZOOMS.map((z, i) => (
          <button
            key={z.label}
            type="button"
            className={`timeline__zoom${i === zoom ? ' is-active' : ''}`}
            aria-pressed={i === zoom}
            onClick={() => setZoom(i)}
          >
            {z.label}
          </button>
        ))}
        <span className="timeline__count">{bars.length} scheduled</span>
      </header>

      <div className="timeline__body" ref={scrollRef}>
        <div className="timeline__labels" style={{ width: LABEL_WIDTH }}>
          {bars.map((bar) => (
            <button
              key={bar.rowId}
              type="button"
              className="timeline__label"
              style={{ height: ROW_HEIGHT }}
              onClick={() => onOpenRow(bar.rowId)}
            >
              {bar.title}
            </button>
          ))}
        </div>

        <div className="timeline__canvas" style={{ width, height: Math.max(bars.length * ROW_HEIGHT, 60) }}>
          <MonthGrid from={span.from} to={span.to} origin={origin} pxPerDay={pxPerDay} />

          {/* Today. The one line on the chart that matters at a glance, and the
              same waterline the island uses. */}
          <div className="timeline__today" style={{ left: xOf(0) }} aria-hidden="true" />

          <svg className="timeline__arrows" width={width} height={Math.max(bars.length * ROW_HEIGHT, 60)}>
            {relationProperty && bars.map((bar) => {
              const page = state.pages[bar.rowId]
              const targets = readStringArray(page?.properties?.[relationProperty.id])
              return targets.map((targetId) => {
                const targetLane = laneOf.get(targetId)
                if (targetLane === undefined) return null
                const target = bars[targetLane]
                const x1 = xOf(bar.endDay + 1)
                const y1 = bar.lane * ROW_HEIGHT + ROW_HEIGHT / 2
                const x2 = xOf(target.startDay)
                const y2 = targetLane * ROW_HEIGHT + ROW_HEIGHT / 2
                const mid = x1 + Math.max(12, (x2 - x1) / 2)
                return (
                  <path
                    key={`${bar.rowId}-${targetId}`}
                    className="timeline__arrow"
                    d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
                    markerEnd="url(#timeline-arrow)"
                  />
                )
              })
            })}
            <defs>
              <marker id="timeline-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" className="timeline__arrowHead" />
              </marker>
            </defs>
          </svg>

          {bars.map((bar) => {
            const left = xOf(bar.startDay)
            const barWidth = Math.max(pxPerDay * 0.9, (bar.endDay - bar.startDay + 1) * pxPerDay)
            const overdue = bar.endDay < 0
            return (
              <div
                key={bar.rowId}
                className={`timeline__task${drag?.rowId === bar.rowId ? ' is-dragging' : ''}${overdue ? ' is-past' : ''}`}
                style={{ left, width: barWidth, top: bar.lane * ROW_HEIGHT + 4, height: ROW_HEIGHT - 8 }}
                onPointerDown={(e) => onPointerDown(e, bar, 'move')}
                onDoubleClick={() => onOpenRow(bar.rowId)}
                role="button"
                tabIndex={0}
                aria-label={`${bar.title}, drag to reschedule`}
                onKeyDown={(e) => {
                  // Keyboard equivalent of the drag: the workspace half has to
                  // work without a pointer.
                  if (e.key === 'ArrowRight') { e.preventDefault(); commit(bar.rowId, bar.startDay + 1, bar.endDay + 1) }
                  if (e.key === 'ArrowLeft') { e.preventDefault(); commit(bar.rowId, bar.startDay - 1, bar.endDay - 1) }
                  if (e.key === 'Enter') onOpenRow(bar.rowId)
                }}
              >
                <span
                  className="timeline__grip timeline__grip--start"
                  onPointerDown={(e) => onPointerDown(e, bar, 'start')}
                  aria-hidden="true"
                />
                <span className="timeline__taskLabel">{bar.title}</span>
                <span
                  className="timeline__grip timeline__grip--end"
                  onPointerDown={(e) => onPointerDown(e, bar, 'end')}
                  aria-hidden="true"
                />
              </div>
            )
          })}
        </div>
      </div>

      <footer className="timeline__foot">
        Drag a bar to reschedule &middot; drag its edges to resize &middot; arrow keys nudge by a day
      </footer>
    </div>
  )
}

function MonthGrid({ from, to, origin, pxPerDay }: { from: number; to: number; origin: number; pxPerDay: number }) {
  const marks: Array<{ day: number; label: string }> = []
  let cursor = new Date(origin + from * MS_PER_DAY)
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  while (true) {
    const day = Math.round((cursor.getTime() - origin) / MS_PER_DAY)
    if (day > to) break
    if (day >= from) {
      marks.push({
        day,
        label: new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(cursor),
      })
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return (
    <>
      {marks.map((mark) => (
        <div key={mark.day} className="timeline__month" style={{ left: (mark.day - from) * pxPerDay }}>
          <span>{mark.label}</span>
        </div>
      ))}
    </>
  )
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
