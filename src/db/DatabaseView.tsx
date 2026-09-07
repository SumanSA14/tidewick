import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import {
  AddProperty, AddView, DeleteProperty, DeleteView, RenameDatabase, UpdateView,
  UpdateProperty, removeFilterNode, replaceFilterNode,
} from '@/state/databaseCommands'
import { newId } from '@/state/blockCommands'
import { AddRelation } from '@/state/relationCommands'
import {
  findProperty, operatorsFor, titleProperty,
  type Database, type FilterRule, type PropertyType, type View, type ViewKind,
} from '@/state/database'
import { runQuery } from './query'
import { TableView } from './views/TableView'
import { BoardView } from './views/BoardView'
import { ListView, GalleryView, CalendarView } from './views/SimpleViews'
import { TimelineView } from './views/TimelineView'
import { FormulaEditor } from './FormulaEditor'

/**
 * The database shell: view tabs, the toolbar, and whichever view is active.
 *
 * Views are saved objects, not transient UI state. Section 6.3 asks for "saved
 * named views", and it matters more than it sounds: a filter that vanishes on
 * reload is a filter nobody trusts enough to rely on. Every change here goes
 * through UpdateView, so it is persisted and undoable like everything else.
 */

export interface DatabaseViewProps {
  databaseId: string
  onOpenRow(rowId: string): void
}

const VIEW_KINDS: Array<{ kind: ViewKind; label: string; glyph: string }> = [
  { kind: 'table', label: 'Table', glyph: '▦' },
  { kind: 'board', label: 'Board', glyph: '▥' },
  { kind: 'calendar', label: 'Calendar', glyph: '▤' },
  { kind: 'gallery', label: 'Gallery', glyph: '▣' },
  { kind: 'list', label: 'List', glyph: '☰' },
  { kind: 'timeline', label: 'Timeline', glyph: '⊞' },
]

const PROPERTY_TYPES: Array<{ type: PropertyType; label: string }> = [
  { type: 'text', label: 'Text' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Select' },
  { type: 'multiSelect', label: 'Multi-select' },
  { type: 'status', label: 'Status' },
  { type: 'date', label: 'Date' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'url', label: 'URL' },
  { type: 'email', label: 'Email' },
  { type: 'phone', label: 'Phone' },
  { type: 'files', label: 'Files' },
  { type: 'relation', label: 'Relation' },
  { type: 'rollup', label: 'Rollup' },
  { type: 'formula', label: 'Formula' },
  { type: 'createdTime', label: 'Created time' },
  { type: 'lastEditedTime', label: 'Last edited' },
]

type Panel = 'none' | 'filter' | 'sort' | 'properties' | 'newProperty' | 'formula'

export function DatabaseView({ databaseId, onOpenRow }: DatabaseViewProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const state = useWorkspaceStore((s) => s.workspace)
  const database = state.databases[databaseId]

  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>('none')
  const [formulaPropertyId, setFormulaPropertyId] = useState<string | null>(null)

  const view = useMemo<View | undefined>(() => {
    if (!database) return undefined
    return database.views.find((v) => v.id === activeViewId) ?? database.views[0]
  }, [database, activeViewId])

  const result = useMemo(
    () => (database && view ? runQuery(state, database, view) : null),
    [state, database, view],
  )

  if (!database || !view || !result) {
    return <p className="db__missing">That database is not here any more.</p>
  }

  const patch = (next: Partial<View>, label?: string) =>
    dispatch(new UpdateView(database.id, view.id, next, label))

  const filterCount = countRules(view)

  return (
    <section className="db">
      <header className="db__head">
        <input
          className="db__name"
          value={database.name}
          aria-label="Database name"
          onChange={(e) => dispatch(new RenameDatabase(database.id, e.target.value))}
        />
      </header>

      <nav className="db__views" aria-label="Views">
        {database.views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`db__tab${v.id === view.id ? ' is-active' : ''}`}
            aria-current={v.id === view.id ? 'true' : undefined}
            onClick={() => setActiveViewId(v.id)}
            onDoubleClick={() => {
              const name = prompt('Rename view', v.name)
              if (name) dispatch(new UpdateView(database.id, v.id, { name }, 'Rename view'))
            }}
          >
            <span aria-hidden="true">{VIEW_KINDS.find((k) => k.kind === v.kind)?.glyph}</span>
            {v.name}
          </button>
        ))}

        <details className="db__addView">
          <summary aria-label="Add a view">+</summary>
          <ul>
            {VIEW_KINDS.map(({ kind, label }) => (
              <li key={kind}>
                <button
                  type="button"
                  onClick={() => {
                    const command = new AddView(database.id, label, kind)
                    dispatch(command)
                    setActiveViewId(command.viewId)
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </details>

        <div className="db__tools">
          <button
            type="button"
            className={`db__tool${filterCount ? ' is-on' : ''}`}
            onClick={() => setPanel(panel === 'filter' ? 'none' : 'filter')}
          >
            Filter{filterCount ? ` (${filterCount})` : ''}
          </button>
          <button
            type="button"
            className={`db__tool${view.sorts.length ? ' is-on' : ''}`}
            onClick={() => setPanel(panel === 'sort' ? 'none' : 'sort')}
          >
            Sort{view.sorts.length ? ` (${view.sorts.length})` : ''}
          </button>
          <button
            type="button"
            className="db__tool"
            onClick={() => setPanel(panel === 'properties' ? 'none' : 'properties')}
          >
            Properties
          </button>
          {database.views.length > 1 && (
            <button
              type="button"
              className="db__tool"
              onClick={() => dispatch(new DeleteView(database.id, view.id))}
            >
              Delete view
            </button>
          )}
        </div>
      </nav>

      {panel === 'filter' && <FilterPanel database={database} view={view} onPatch={patch} />}
      {panel === 'sort' && <SortPanel database={database} view={view} onPatch={patch} />}
      {panel === 'properties' && (
        <PropertiesPanel
          database={database}
          view={view}
          onPatch={patch}
          onAdd={() => setPanel('newProperty')}
          onEditFormula={(id) => { setFormulaPropertyId(id); setPanel('formula') }}
        />
      )}
      {panel === 'formula' && formulaPropertyId && findProperty(database, formulaPropertyId) && (
        <FormulaEditor
          database={database}
          property={findProperty(database, formulaPropertyId)!}
          onDone={() => setPanel('properties')}
        />
      )}
      {panel === 'newProperty' && (
        <NewPropertyPanel database={database} onDone={() => setPanel('properties')} />
      )}

      <div className="db__body">
        {view.kind === 'table' && <TableView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
        {view.kind === 'board' && <BoardView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
        {view.kind === 'list' && <ListView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
        {view.kind === 'gallery' && <GalleryView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
        {view.kind === 'calendar' && <CalendarView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
        {view.kind === 'timeline' && <TimelineView database={database} view={view} result={result} onOpenRow={onOpenRow} />}
      </div>
    </section>
  )
}

function countRules(view: View): number {
  let n = 0
  const walk = (node: View['filter'] | FilterRule) => {
    if (node.kind === 'rule') { n++; return }
    for (const child of node.children) walk(child)
  }
  walk(view.filter)
  return n
}

// --- panels ----------------------------------------------------------------

interface PanelProps {
  database: Database
  view: View
  onPatch(next: Partial<View>, label?: string): void
}

function FilterPanel({ database, view, onPatch }: PanelProps) {
  const rules = view.filter.children.filter((c): c is FilterRule => c.kind === 'rule')

  const addRule = () => {
    const property = database.properties[0]
    const rule: FilterRule = {
      kind: 'rule',
      id: newId(),
      propertyId: property.id,
      operator: operatorsFor(property.type)[0],
      value: null,
    }
    onPatch({ filter: { ...view.filter, children: [...view.filter.children, rule] } }, 'Add filter')
  }

  return (
    <div className="panel" role="region" aria-label="Filters">
      <div className="panel__row">
        <label>
          <span className="panel__label">Match</span>
          <select
            value={view.filter.op}
            onChange={(e) => onPatch({ filter: { ...view.filter, op: e.target.value as 'and' | 'or' } }, 'Change filter mode')}
          >
            <option value="and">all conditions</option>
            <option value="or">any condition</option>
          </select>
        </label>
      </div>

      {rules.map((rule) => {
        const property = findProperty(database, rule.propertyId)
        const operators = property ? operatorsFor(property.type) : []
        const needsValue = !['isEmpty', 'isNotEmpty', 'checked', 'unchecked'].includes(rule.operator)
        return (
          <div className="panel__row" key={rule.id}>
            <select
              aria-label="Property"
              value={rule.propertyId}
              onChange={(e) => {
                const next = findProperty(database, e.target.value)
                onPatch({
                  filter: replaceFilterNode(view.filter, rule.id, {
                    ...rule,
                    propertyId: e.target.value,
                    operator: next ? operatorsFor(next.type)[0] : rule.operator,
                    value: null,
                  }),
                }, 'Edit filter')
              }}
            >
              {database.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            <select
              aria-label="Condition"
              value={rule.operator}
              onChange={(e) => onPatch({
                filter: replaceFilterNode(view.filter, rule.id, { ...rule, operator: e.target.value as FilterRule['operator'] }),
              }, 'Edit filter')}
            >
              {operators.map((op) => <option key={op} value={op}>{operatorLabel(op)}</option>)}
            </select>

            {needsValue && (
              <input
                aria-label="Value"
                className="panel__value"
                value={typeof rule.value === 'string' || typeof rule.value === 'number' ? String(rule.value) : ''}
                placeholder="Value"
                onChange={(e) => {
                  const raw = e.target.value
                  const coerced = property?.type === 'number'
                    ? (raw === '' ? null : Number(raw))
                    : property?.type === 'date'
                      ? (raw === '' ? null : { start: raw })
                      : raw
                  onPatch({ filter: replaceFilterNode(view.filter, rule.id, { ...rule, value: coerced }) }, 'Edit filter')
                }}
                type={property?.type === 'date' ? 'date' : property?.type === 'number' ? 'number' : 'text'}
              />
            )}

            <button
              type="button"
              className="panel__remove"
              aria-label="Remove filter"
              onClick={() => onPatch({ filter: removeFilterNode(view.filter, rule.id) }, 'Remove filter')}
            >
              &times;
            </button>
          </div>
        )
      })}

      <button type="button" className="panel__add" onClick={addRule}>+ Add condition</button>
    </div>
  )
}

function SortPanel({ database, view, onPatch }: PanelProps) {
  return (
    <div className="panel" role="region" aria-label="Sorting">
      {view.sorts.map((sort, index) => (
        <div className="panel__row" key={`${sort.propertyId}-${index}`}>
          <select
            aria-label="Sort property"
            value={sort.propertyId}
            onChange={(e) => onPatch({
              sorts: view.sorts.map((s, i) => (i === index ? { ...s, propertyId: e.target.value } : s)),
            }, 'Change sort')}
          >
            {database.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select
            aria-label="Sort direction"
            value={sort.direction}
            onChange={(e) => onPatch({
              sorts: view.sorts.map((s, i) => (i === index ? { ...s, direction: e.target.value as 'asc' | 'desc' } : s)),
            }, 'Change sort')}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button
            type="button"
            className="panel__remove"
            aria-label="Remove sort"
            onClick={() => onPatch({ sorts: view.sorts.filter((_, i) => i !== index) }, 'Remove sort')}
          >
            &times;
          </button>
        </div>
      ))}

      <button
        type="button"
        className="panel__add"
        onClick={() => onPatch({
          sorts: [...view.sorts, { propertyId: titleProperty(database).id, direction: 'asc' as const }],
        }, 'Add sort')}
      >
        + Add sort
      </button>

      <div className="panel__row">
        <label>
          <span className="panel__label">Group by</span>
          <select
            value={view.groupBy ?? ''}
            onChange={(e) => onPatch({ groupBy: e.target.value || undefined }, 'Change grouping')}
          >
            <option value="">None</option>
            {database.properties
              .filter((p) => ['select', 'status', 'multiSelect', 'checkbox'].includes(p.type))
              .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

function PropertiesPanel({ database, view, onPatch, onAdd, onEditFormula }: PanelProps & {
  onAdd(): void
  onEditFormula(propertyId: string): void
}) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)

  return (
    <div className="panel" role="region" aria-label="Properties">
      {database.properties.map((property) => {
        const visible = view.visibleProperties.includes(property.id)
        return (
          <div className="panel__row" key={property.id}>
            <label className="panel__toggle">
              <input
                type="checkbox"
                checked={visible}
                disabled={property.type === 'title'}
                onChange={() => onPatch({
                  visibleProperties: visible
                    ? view.visibleProperties.filter((id) => id !== property.id)
                    : [...view.visibleProperties, property.id],
                }, 'Show or hide property')}
              />
              <input
                className="panel__rename"
                value={property.name}
                aria-label={`Rename ${property.name}`}
                onChange={(e) => dispatch(new UpdateProperty(database.id, property.id, { name: e.target.value }))}
              />
            </label>
            {property.type === 'formula' ? (
              <button type="button" className="panel__type panel__type--action" onClick={() => onEditFormula(property.id)}>
                {property.formula ? 'edit formula' : 'add formula'}
              </button>
            ) : (
              <span className="panel__type">{property.type}</span>
            )}
            {property.type !== 'title' && (
              <button
                type="button"
                className="panel__remove"
                aria-label={`Delete ${property.name}`}
                onClick={() => dispatch(new DeleteProperty(database.id, property.id))}
              >
                &times;
              </button>
            )}
          </div>
        )
      })}
      <button type="button" className="panel__add" onClick={onAdd}>+ Add property</button>
    </div>
  )
}

function NewPropertyPanel({ database, onDone }: { database: Database; onDone(): void }) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const state = useWorkspaceStore((s) => s.workspace)
  const [name, setName] = useState('')
  const [type, setType] = useState<PropertyType>('text')
  const [relationTarget, setRelationTarget] = useState('')

  const otherDatabases = Object.values(state.databases)

  const create = () => {
    const label = name.trim() || PROPERTY_TYPES.find((t) => t.type === type)?.label || 'Property'
    if (type === 'relation') {
      if (!relationTarget) return
      // Creates both sides at once, per Section 6.4.
      dispatch(new AddRelation(database.id, relationTarget, label, database.name || 'Related'))
      onDone()
      return
    }
    dispatch(new AddProperty(database.id, type, label, newId()))
    onDone()
  }

  return (
    <div className="panel" role="region" aria-label="New property">
      <div className="panel__row">
        <input
          className="panel__rename"
          autoFocus
          value={name}
          placeholder="Property name"
          aria-label="New property name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create() }}
        />
        <select aria-label="Property type" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
          {PROPERTY_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </div>

      {type === 'relation' && (
        <div className="panel__row">
          <label>
            <span className="panel__label">Links to</span>
            <select value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)}>
              <option value="">Choose a database</option>
              {otherDatabases.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        </div>
      )}

      <div className="panel__row">
        <button type="button" className="panel__add" onClick={create}>Create</button>
        <button type="button" className="panel__remove panel__cancel" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

function operatorLabel(op: string): string {
  switch (op) {
    case 'is': return 'is'
    case 'isNot': return 'is not'
    case 'contains': return 'contains'
    case 'doesNotContain': return 'does not contain'
    case 'startsWith': return 'starts with'
    case 'endsWith': return 'ends with'
    case 'isEmpty': return 'is empty'
    case 'isNotEmpty': return 'is not empty'
    case 'greaterThan': return 'is greater than'
    case 'lessThan': return 'is less than'
    case 'greaterOrEqual': return 'is at least'
    case 'lessOrEqual': return 'is at most'
    case 'before': return 'is before'
    case 'after': return 'is after'
    case 'onOrBefore': return 'is on or before'
    case 'onOrAfter': return 'is on or after'
    case 'isWithin': return 'is within'
    case 'checked': return 'is checked'
    case 'unchecked': return 'is unchecked'
    default: return op
  }
}
