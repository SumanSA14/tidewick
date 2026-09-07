import { useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { AddRow, SetPropertyValue, UpdateView } from '@/state/databaseCommands'
import { findProperty } from '@/state/database'
import { PropertyCell } from '../PropertyCell'
import { EMPTY_GROUP_KEY } from '../query'
import type { ViewProps } from './TableView'

/**
 * The Board view.
 *
 * Dragging a card between columns writes back to the grouping property - it is
 * not a display-only rearrangement. That is the whole point of a Board, and it
 * is also what makes the island work later: dropping a card into "Complete"
 * dispatches the same command that will bloom the plant and light the lantern.
 *
 * Native HTML drag and drop rather than a library. It is keyboard-inert, so
 * every card also carries a move control that works without a pointer -
 * Section 13 requires the workspace to be fully usable from the keyboard.
 */
export function BoardView({ database, view, result, onOpenRow }: ViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const pages = useWorkspaceStore((s) => s.workspace.pages)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const groupProperty = view.groupBy ? findProperty(database, view.groupBy) : undefined
  const collapsed = new Set(view.collapsedGroups ?? [])

  if (!groupProperty) {
    return (
      <p className="board__hint">
        A board needs a property to group by. Add a Select or Status property, then choose it here.
      </p>
    )
  }

  const cardProperties = view.visibleProperties
    .map((id) => findProperty(database, id))
    .filter((p) => p && p.id !== groupProperty.id && p.type !== 'title')
    .slice(0, 4) as NonNullable<ReturnType<typeof findProperty>>[]

  /** Write the drop back to the grouping property. */
  const moveTo = (rowId: string, groupKey: string) => {
    const next = groupKey === EMPTY_GROUP_KEY ? null : groupKey
    dispatch(new SetPropertyValue(rowId, groupProperty.id, next, `Move to ${groupKey}`))
  }

  const toggleCollapse = (key: string) => {
    const nextSet = new Set(collapsed)
    if (nextSet.has(key)) nextSet.delete(key)
    else nextSet.add(key)
    dispatch(new UpdateView(database.id, view.id, { collapsedGroups: [...nextSet] }, 'Collapse column'))
  }

  const groups = result.groups ?? []

  return (
    <div className="board">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key)
        return (
          <section
            key={group.key}
            className={`board__column${isCollapsed ? ' is-collapsed' : ''}${over === group.key ? ' is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(group.key) }}
            onDragLeave={() => setOver((k) => (k === group.key ? null : k))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              if (dragging) moveTo(dragging, group.key)
              setDragging(null)
            }}
            aria-label={`${group.label}, ${group.rows.length} cards`}
          >
            <header className="board__head">
              <button
                type="button"
                className="board__collapse"
                onClick={() => toggleCollapse(group.key)}
                aria-expanded={!isCollapsed}
              >
                <span className={`chip chip--${group.colour ?? 'slate'}`}>{group.label}</span>
                <span className="board__count">{group.rows.length}</span>
              </button>
            </header>

            {!isCollapsed && (
              <>
                <div className="board__cards">
                  {group.rows.map((rowId) => {
                    const page = pages[rowId]
                    if (!page) return null
                    return (
                      <article
                        key={rowId}
                        className={`card${dragging === rowId ? ' is-dragging' : ''}`}
                        draggable
                        onDragStart={(e) => {
                          setDragging(rowId)
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData('text/plain', rowId)
                        }}
                        onDragEnd={() => { setDragging(null); setOver(null) }}
                      >
                        <button type="button" className="card__title" onClick={() => onOpenRow(rowId)}>
                          {page.title || 'Untitled'}
                        </button>

                        {cardProperties.length > 0 && (
                          <div className="card__props">
                            {cardProperties.map((property) => (
                              <PropertyCell
                                key={property.id}
                                page={page}
                                property={property}
                                database={database}
                                variant="card"
                              />
                            ))}
                          </div>
                        )}

                        {/* Keyboard equivalent of the drag, since native DnD
                            cannot be driven from the keyboard at all. */}
                        <label className="card__move">
                          <span className="visually-hidden">Move {page.title || 'Untitled'} to</span>
                          <select
                            value={group.key}
                            onChange={(e) => moveTo(rowId, e.target.value)}
                          >
                            {groups.map((g) => (
                              <option key={g.key} value={g.key}>{g.label}</option>
                            ))}
                          </select>
                        </label>
                      </article>
                    )
                  })}
                </div>

                <button
                  type="button"
                  className="board__add"
                  onClick={() => dispatch(new AddRow(
                    database.id,
                    group.key === EMPTY_GROUP_KEY ? {} : { [groupProperty.id]: group.key },
                  ))}
                >
                  + New
                </button>
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}
