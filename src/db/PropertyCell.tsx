import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { SetPropertyValue, AddSelectOption } from '@/state/databaseCommands'
import { SetRelation } from '@/state/relationCommands'
import { SetPageTitle } from '@/state/blockCommands'
import {
  readString, readNumber, readDate, readStringArray, readBoolean, isEmptyValue,
  COMPUTED_TYPES, OPTION_COLOURS,
  type Database, type PropertyDef, type PropertyValue, type SelectOption,
  parseStoredDate,
} from '@/state/database'
import type { Page } from '@/state/blocks'
import { valueOf } from './query'

/**
 * One cell: display and edit, for every property type.
 *
 * Kept as a single component rather than one per type because every view needs
 * all of them and the differences are mostly a few lines each. The shared parts
 * - click to edit, Escape to cancel, Enter to commit, blur to commit - are the
 * bits users actually notice, and they are much easier to keep consistent in
 * one place than across sixteen files.
 *
 * Computed types render read-only. Writing to a rollup would mean writing to
 * whatever it summarised, which is not a thing a cell can honestly offer.
 */

export interface PropertyCellProps {
  page: Page
  property: PropertyDef
  database: Database
  /** Table cells are dense; card and list cells give the value more room. */
  variant?: 'table' | 'card'
  readOnly?: boolean
  /** Called after a commit, so a view can move focus onward. */
  onCommit?(): void
}

export function PropertyCell({ page, property, database, variant = 'table', readOnly, onCommit }: PropertyCellProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const state = useWorkspaceStore((s) => s.workspace)
  const [editing, setEditing] = useState(false)

  const value = valueOf(state, page, property)
  const computed = COMPUTED_TYPES.has(property.type)
  const locked = readOnly || computed

  const commit = (next: PropertyValue) => {
    if (property.type === 'title') {
      dispatch(new SetPageTitle(page.id, readString(next)))
    } else if (property.type === 'relation') {
      // Relations write through their own command, which maintains the inverse
      // on the far side. SetPropertyValue would leave it dangling.
      dispatch(new SetRelation(page.id, property.id, readStringArray(next)))
    } else {
      dispatch(new SetPropertyValue(page.id, property.id, next, `Edit ${property.name}`))
    }
    setEditing(false)
    onCommit?.()
  }

  // Checkbox has no edit mode - a checkbox that needs a click to become
  // clickable is a checkbox nobody ticks.
  if (property.type === 'checkbox') {
    return (
      <label className="cell cell--checkbox">
        <input
          type="checkbox"
          checked={readBoolean(value)}
          disabled={locked}
          onChange={(e) => commit(e.target.checked)}
          aria-label={property.name}
        />
      </label>
    )
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`cell cell--${property.type} cell--${variant}${locked ? ' is-locked' : ''}`}
        onClick={() => !locked && setEditing(true)}
        disabled={locked}
        aria-label={`${property.name}: ${readString(value) || 'empty'}`}
      >
        <CellDisplay value={value} property={property} />
      </button>
    )
  }

  return (
    <div className={`cell cell--editing cell--${property.type}`}>
      <CellEditor
        value={value}
        property={property}
        database={database}
        onCommit={commit}
        onCancel={() => setEditing(false)}
      />
    </div>
  )
}

// --- display ---------------------------------------------------------------

function CellDisplay({ value, property }: { value: PropertyValue; property: PropertyDef }) {
  const state = useWorkspaceStore((s) => s.workspace)

  if (isEmptyValue(value)) return <span className="cell__empty" />

  switch (property.type) {
    case 'select':
    case 'status': {
      const option = findOption(property, value)
      return option ? <Chip option={option} /> : <span>{readString(value)}</span>
    }
    case 'multiSelect': {
      const ids = readStringArray(value)
      return (
        <span className="chips">
          {ids.map((id) => {
            const option = findOption(property, id)
            return option ? <Chip key={id} option={option} /> : <span key={id}>{id}</span>
          })}
        </span>
      )
    }
    case 'relation': {
      const ids = readStringArray(value)
      return (
        <span className="chips">
          {ids.map((id) => (
            <span className="chip chip--relation" key={id}>
              {state.pages[id]?.title || 'Untitled'}
            </span>
          ))}
        </span>
      )
    }
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return <span>{formatDate(value, property)}</span>
    case 'number':
      return <span className="cell__number">{formatNumber(value, property)}</span>
    case 'url': {
      const href = readString(value)
      return <span className="cell__link">{href}</span>
    }
    case 'files': {
      const files = Array.isArray(value) ? value : []
      return <span className="cell__files">{files.length} file{files.length === 1 ? '' : 's'}</span>
    }
    case 'rollup':
      return <span className="cell__computed">{formatRollup(value, property)}</span>
    case 'formula':
      // Phase 5 brings the parser. Until then say so rather than showing an
      // empty cell that looks like a broken value.
      return <span className="cell__computed cell__pending">formula</span>
    default:
      return <span>{readString(value)}</span>
  }
}

function Chip({ option }: { option: SelectOption }) {
  return <span className={`chip chip--${option.colour}`}>{option.name}</span>
}

// --- editing ---------------------------------------------------------------

interface EditorProps {
  value: PropertyValue
  property: PropertyDef
  database: Database
  onCommit(next: PropertyValue): void
  onCancel(): void
}

function CellEditor({ value, property, database, onCommit, onCancel }: EditorProps) {
  switch (property.type) {
    case 'select':
    case 'status':
      return <SelectEditor value={value} property={property} database={database} onCommit={onCommit} onCancel={onCancel} multi={false} />
    case 'multiSelect':
      return <SelectEditor value={value} property={property} database={database} onCommit={onCommit} onCancel={onCancel} multi />
    case 'relation':
      return <RelationEditor value={value} property={property} onCommit={onCommit} onCancel={onCancel} />
    case 'date':
      return <DateEditor value={value} property={property} onCommit={onCommit} onCancel={onCancel} />
    case 'files':
      return <FilesEditor value={value} onCommit={onCommit} onCancel={onCancel} />
    default:
      return <TextEditor value={value} property={property} onCommit={onCommit} onCancel={onCancel} />
  }
}

function TextEditor({ value, property, onCommit, onCancel }: Omit<EditorProps, 'database'>) {
  const [draft, setDraft] = useState(readString(value))
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => { ref.current?.select() }, [])

  const inputType =
    property.type === 'number' ? 'number'
    : property.type === 'email' ? 'email'
    : property.type === 'url' ? 'url'
    : property.type === 'phone' ? 'tel'
    : 'text'

  const finish = () => {
    if (property.type === 'number') {
      const n = readNumber(draft)
      onCommit(draft.trim() === '' ? null : n)
    } else {
      onCommit(draft)
    }
  }

  return (
    <input
      ref={ref}
      className="cell__input"
      type={inputType}
      value={draft}
      aria-label={property.name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish() }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
    />
  )
}

function SelectEditor({ value, property, database, onCommit, onCancel, multi }: EditorProps & { multi: boolean }) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const [query, setQuery] = useState('')
  const selected = multi ? readStringArray(value) : [readString(value)].filter(Boolean)
  const options = property.options ?? []
  const matches = options.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()))
  const exact = options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase())

  const pick = (id: string) => {
    if (!multi) return onCommit(id)
    onCommit(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  const createOption = () => {
    const name = query.trim()
    if (!name) return
    // Colours cycle through the palette so a new option is never the same as
    // the one above it. There is no red in the palette, deliberately.
    const colour = OPTION_COLOURS[options.length % OPTION_COLOURS.length]
    dispatch(new AddSelectOption(database.id, property.id, name, colour))
    setQuery('')
  }

  return (
    <div className="picker" role="dialog" aria-label={property.name}>
      <input
        className="picker__search"
        autoFocus
        value={query}
        placeholder="Search or create"
        aria-label={`Search ${property.name} options`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          if (e.key === 'Enter') {
            e.preventDefault()
            if (matches.length) pick(matches[0].id)
            else if (!exact) createOption()
          }
        }}
      />
      <ul className="picker__list">
        {matches.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              className={`picker__item${selected.includes(option.id) ? ' is-selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(option.id) }}
            >
              <Chip option={option} />
            </button>
          </li>
        ))}
        {query.trim() && !exact && (
          <li>
            <button type="button" className="picker__item picker__create" onMouseDown={(e) => { e.preventDefault(); createOption() }}>
              Create &ldquo;{query.trim()}&rdquo;
            </button>
          </li>
        )}
        {selected.length > 0 && !multi && (
          <li>
            <button type="button" className="picker__item picker__clear" onMouseDown={(e) => { e.preventDefault(); onCommit(null) }}>
              Clear
            </button>
          </li>
        )}
      </ul>
      {multi && (
        <button type="button" className="picker__done" onMouseDown={(e) => { e.preventDefault(); onCancel() }}>Done</button>
      )}
    </div>
  )
}

function RelationEditor({ value, property, onCommit, onCancel }: Omit<EditorProps, 'database'>) {
  const state = useWorkspaceStore((s) => s.workspace)
  const [query, setQuery] = useState('')
  const selected = readStringArray(value)
  const target = property.relationDatabaseId ? state.databases[property.relationDatabaseId] : undefined

  const candidates = useMemo(() => {
    if (!target) return []
    return target.rows
      .map((id) => state.pages[id])
      .filter((p) => p && !p.trashed)
      .filter((p) => p.title.toLowerCase().includes(query.trim().toLowerCase()))
      .slice(0, 40)
  }, [target, state.pages, query])

  if (!target) {
    return <p className="picker picker--empty">This relation has no target database yet.</p>
  }

  const toggle = (id: string) => {
    onCommit(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  return (
    <div className="picker" role="dialog" aria-label={property.name}>
      <input
        className="picker__search"
        autoFocus
        value={query}
        placeholder={`Search ${target.name}`}
        aria-label={`Search ${target.name}`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }}
      />
      <ul className="picker__list">
        {candidates.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              className={`picker__item${selected.includes(page.id) ? ' is-selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); toggle(page.id) }}
            >
              {page.title || 'Untitled'}
            </button>
          </li>
        ))}
        {candidates.length === 0 && <li className="picker__none">Nothing to link yet</li>}
      </ul>
      <button type="button" className="picker__done" onMouseDown={(e) => { e.preventDefault(); onCancel() }}>Done</button>
    </div>
  )
}

function DateEditor({ value, property, onCommit, onCancel }: Omit<EditorProps, 'database'>) {
  const current = readDate(value)
  const withTime = property.includesTime ?? false
  const [start, setStart] = useState(toInputValue(current?.start, withTime))
  const [end, setEnd] = useState(toInputValue(current?.end, withTime))
  const [ranged, setRanged] = useState(Boolean(current?.end))

  const finish = () => {
    if (!start) return onCommit(null)
    onCommit({ start, end: ranged && end ? end : undefined, hasTime: withTime })
  }

  return (
    <div className="picker picker--date" role="dialog" aria-label={property.name}>
      <input
        className="picker__date"
        type={withTime ? 'datetime-local' : 'date'}
        value={start}
        autoFocus
        aria-label={`${property.name} start`}
        onChange={(e) => setStart(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish() }
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      />
      {ranged && (
        <input
          className="picker__date"
          type={withTime ? 'datetime-local' : 'date'}
          value={end}
          aria-label={`${property.name} end`}
          onChange={(e) => setEnd(e.target.value)}
        />
      )}
      <div className="picker__row">
        <button type="button" className="picker__small" onMouseDown={(e) => { e.preventDefault(); setRanged((r) => !r) }}>
          {ranged ? 'Single date' : 'End date'}
        </button>
        <button type="button" className="picker__small" onMouseDown={(e) => { e.preventDefault(); onCommit(null) }}>Clear</button>
        <button type="button" className="picker__done" onMouseDown={(e) => { e.preventDefault(); finish() }}>Done</button>
      </div>
    </div>
  )
}

/**
 * Files, stored inline as data URIs.
 *
 * Local-first means there is nowhere to upload to, and an object URL would not
 * survive a reload - so small files are inlined and large ones are recorded by
 * name only rather than quietly bloating IndexedDB with a video.
 */
const MAX_INLINE_FILE_BYTES = 512 * 1024

function FilesEditor({ value, onCommit, onCancel }: Omit<EditorProps, 'database' | 'property'>) {
  const existing = Array.isArray(value) ? (value as Array<{ id: string; name: string; url: string; size?: number }>) : []

  const onPick = async (list: FileList | null) => {
    if (!list?.length) return
    const added = await Promise.all(Array.from(list).map(async (file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      url: file.size <= MAX_INLINE_FILE_BYTES ? await readAsDataUrl(file) : '',
    })))
    onCommit([...existing, ...added] as PropertyValue)
  }

  return (
    <div className="picker" role="dialog" aria-label="Files">
      <ul className="picker__list">
        {existing.map((file) => (
          <li key={file.id} className="picker__file">
            <span>{file.name}</span>
            <button
              type="button"
              className="picker__small"
              onMouseDown={(e) => { e.preventDefault(); onCommit(existing.filter((f) => f.id !== file.id) as PropertyValue) }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <input type="file" multiple aria-label="Add files" onChange={(e) => void onPick(e.target.files)} />
      <button type="button" className="picker__done" onMouseDown={(e) => { e.preventDefault(); onCancel() }}>Done</button>
    </div>
  )
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}

// --- formatting ------------------------------------------------------------

function findOption(property: PropertyDef, value: PropertyValue): SelectOption | undefined {
  const key = readString(value)
  return property.options?.find((o) => o.id === key || o.name === key)
}

export function formatNumber(value: PropertyValue, property: PropertyDef): string {
  const n = readNumber(value)
  if (n === null) return ''
  switch (property.numberFormat) {
    case 'integer':
      return String(Math.round(n))
    case 'percent':
      return `${(n * 100).toFixed(n * 100 % 1 === 0 ? 0 : 1)}%`
    case 'currency':
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: property.currency || 'INR',
          maximumFractionDigits: 2,
        }).format(n)
      } catch {
        // An unknown currency code must not take the whole table down.
        return `${property.currency ?? ''} ${n}`.trim()
      }
    default:
      return String(n)
  }
}

export function formatDate(value: PropertyValue, property: PropertyDef): string {
  const date = readDate(value)
  if (!date) return ''
  const withTime = date.hasTime || property.includesTime
  const options: Intl.DateTimeFormatOptions = withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' }
  const start = safeFormat(date.start, options)
  return date.end ? `${start} → ${safeFormat(date.end, options)}` : start
}

function safeFormat(iso: string, options: Intl.DateTimeFormatOptions): string {
  // Local anchor for bare dates - see parseStoredDate. Date.parse here showed
  // June 14 as June 13 for anyone west of Greenwich.
  const ms = parseStoredDate(iso)
  if (!Number.isFinite(ms)) return iso
  return new Intl.DateTimeFormat(undefined, options).format(new Date(ms))
}

function formatRollup(value: PropertyValue, property: PropertyDef): string {
  if (property.rollupFunction === 'percentComplete') {
    const n = readNumber(value)
    return n === null ? '' : `${Math.round(n * 100)}%`
  }
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  return readString(value)
}

/** Convert a stored ISO value into what a date input expects. */
function toInputValue(iso: string | undefined, withTime: boolean): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day
}
