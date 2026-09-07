/**
 * User-defined databases.
 *
 * No domain is hard-coded into the engine, per Section 6.2: the Placement Prep
 * pack in Section 7 is *data*, constructed from these primitives at runtime,
 * not a set of built-in schemas.
 *
 * A row is a Page. That is not an implementation shortcut - it is what makes
 * Section 4's mapping work. The brief maps "Page / Task" to a plant on the
 * island and "Database / Project" to a region; if rows were their own entity
 * type, every derivation would need two code paths for the same concept. This
 * way a row has a title, a body of blocks, and property values, and the island
 * does not care which of those a plant grew from.
 */

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'createdTime'
  | 'lastEditedTime'

export type NumberFormat = 'plain' | 'integer' | 'currency' | 'percent'

/** Status options are grouped, which is what lets the island read progress. */
export type StatusGroup = 'todo' | 'inProgress' | 'complete'

export interface SelectOption {
  id: string
  name: string
  /** Palette token, never a raw colour - the season palette owns the hues. */
  colour: string
  /** Status properties only. */
  group?: StatusGroup
}

export interface PropertyDef {
  id: string
  name: string
  type: PropertyType
  options?: SelectOption[]
  numberFormat?: NumberFormat
  currency?: string
  /** Date properties: whether the editor offers a time as well as a day. */
  includesTime?: boolean
  /** Relation properties: the database on the other side. */
  relationDatabaseId?: string
  /** Relation properties: the inverse property created on the other side. */
  inversePropertyId?: string
  /** Rollup properties: which relation to walk and what to read through it. */
  rollupRelationId?: string
  rollupTargetPropertyId?: string
  rollupFunction?: RollupFunction
  /** Formula properties: the source expression. */
  formula?: string
}

export type RollupFunction =
  | 'countAll' | 'countUnique' | 'countEmpty' | 'countNotEmpty'
  | 'sum' | 'average' | 'min' | 'max'
  | 'earliest' | 'latest'
  | 'showOriginal' | 'percentComplete'

/**
 * A date, stored as ISO strings.
 *
 * Strings rather than epoch numbers because a date with no time is a *day*, not
 * an instant - storing "2026-03-14" as a timestamp silently commits it to a
 * timezone, and the task then moves across the island elevation gradient
 * depending on where the user happens to be standing.
 */
export interface DateValue {
  /** ISO date, or ISO datetime when `hasTime`. */
  start: string
  end?: string
  hasTime?: boolean
}

export interface FileRef {
  id: string
  name: string
  /** Object URL or data URI. Local-first: nothing is uploaded anywhere. */
  url: string
  size?: number
}

/**
 * A stored property value.
 *
 * Raw rather than tagged, with the PropertyDef as the single source of truth
 * for interpretation. A tagged union would duplicate the type in every cell of
 * every row, and changing a property type would then mean rewriting all of
 * them rather than reinterpreting them.
 */
export type PropertyValue =
  | string
  | number
  | boolean
  | string[]
  | DateValue
  | FileRef[]
  | null

export type ViewKind = 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'timeline'

export type FilterOperator =
  | 'is' | 'isNot'
  | 'contains' | 'doesNotContain'
  | 'startsWith' | 'endsWith'
  | 'isEmpty' | 'isNotEmpty'
  | 'greaterThan' | 'lessThan' | 'greaterOrEqual' | 'lessOrEqual'
  | 'before' | 'after' | 'onOrBefore' | 'onOrAfter'
  | 'isWithin'
  | 'checked' | 'unchecked'

export interface FilterRule {
  kind: 'rule'
  id: string
  propertyId: string
  operator: FilterOperator
  value?: PropertyValue
}

export interface FilterGroup {
  kind: 'group'
  id: string
  op: 'and' | 'or'
  children: Array<FilterGroup | FilterRule>
}

export type FilterNode = FilterGroup | FilterRule

export interface SortRule {
  propertyId: string
  direction: 'asc' | 'desc'
}

export interface View {
  id: string
  name: string
  kind: ViewKind
  filter: FilterGroup
  /** Multi-level: earlier entries win, later ones break ties. */
  sorts: SortRule[]
  /** Property to group rows by. Board requires one; others may have one. */
  groupBy?: string
  /** Ordered property ids shown in this view. */
  visibleProperties: string[]
  /** Calendar and Timeline: which date property positions a row. */
  dateProperty?: string
  /** Gallery: which property supplies the card cover. */
  coverProperty?: string
  /** Table: persisted column widths, keyed by property id. */
  columnWidths?: Record<string, number>
  /** Board: columns the user has collapsed. */
  collapsedGroups?: string[]
}

export interface Database {
  id: string
  name: string
  /** Ordered. The first title-typed property is the row display name. */
  properties: PropertyDef[]
  /** Ordered view ids; views live here rather than globally. */
  views: View[]
  /** Ordered row page ids. */
  rows: string[]
  createdAt: number
}

// --- construction ----------------------------------------------------------

export function createDatabase(
  id: string,
  name: string,
  titlePropertyId: string,
  viewId: string,
  now = Date.now(),
): Database {
  return {
    id,
    name,
    properties: [{ id: titlePropertyId, name: 'Name', type: 'title' }],
    views: [createView(viewId, 'Table', 'table', [titlePropertyId])],
    rows: [],
    createdAt: now,
  }
}

export function createView(id: string, name: string, kind: ViewKind, visibleProperties: string[]): View {
  return {
    id,
    name,
    kind,
    filter: { kind: 'group', id: `${id}-root`, op: 'and', children: [] },
    sorts: [],
    visibleProperties: [...visibleProperties],
  }
}

export const DEFAULT_STATUS_OPTIONS: Array<Omit<SelectOption, 'id'>> = [
  { name: 'To-do', colour: 'slate', group: 'todo' },
  { name: 'In progress', colour: 'teal', group: 'inProgress' },
  { name: 'Complete', colour: 'moss', group: 'complete' },
]

/**
 * Option colours, named rather than hex.
 *
 * The island and the workspace share one palette, and Section 8 forbids red
 * anywhere - so there is deliberately no red token here for a user to pick.
 * Urgency in this product is proximity to water and nothing else.
 */
export const OPTION_COLOURS = [
  'slate', 'teal', 'moss', 'sand', 'amber', 'clay', 'lilac', 'sky',
] as const

export type OptionColour = typeof OPTION_COLOURS[number]

// --- reading values --------------------------------------------------------

export function isEmptyValue(value: PropertyValue | undefined): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return !(value as DateValue).start
  return false
}

export function readString(value: PropertyValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : (v as FileRef).name ?? ''))
      .join(', ')
  }
  return (value as DateValue).start ?? ''
}

export function readNumber(value: PropertyValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

export function readDate(value: PropertyValue | undefined): DateValue | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    const date = value as DateValue
    return date.start ? date : null
  }
  if (typeof value === 'string' && value.trim() !== '') return { start: value }
  return null
}

export function readStringArray(value: PropertyValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value) return [value]
  return []
}

/**
 * A plain, detached copy of a property value.
 *
 * Undo entries capture the previous value *during* an Immer `produce`, which
 * means an object- or array-valued property is captured as a live draft proxy.
 * That proxy is revoked the moment the produce finishes, so writing it back on
 * undo throws "Cannot perform 'get' on a proxy that has been revoked" - and it
 * throws for dates, multi-selects and file lists, which is to say for most of
 * the interesting property types.
 *
 * `cloneBlock` exists in blocks.ts for exactly the same reason. Anything that
 * stores state across a produce boundary has to detach it first.
 */
export function clonePropertyValue(value: PropertyValue | undefined): PropertyValue | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === 'object' ? { ...item } : item,
    ) as PropertyValue
  }
  return { ...(value as DateValue) }
}

export function readBoolean(value: PropertyValue | undefined): boolean {
  return value === true || value === 'true'
}

/**
 * Parse a stored date to epoch milliseconds, or null.
 *
 * A date-only value (`YYYY-MM-DD`) is a *calendar day* - it is what the date
 * picker writes and what a person means by "due Friday". `Date.parse` treats
 * that form as UTC midnight, which then formats as the *previous evening* for
 * everyone west of Greenwich: a task due June 14 displayed as June 13 across
 * the whole of the Americas. So a bare date is anchored at local midnight, the
 * same anchor the picker used to write it. Datetimes keep their own offset.
 */
export function dateToMillis(value: PropertyValue | undefined): number | null {
  const date = readDate(value)
  if (!date) return null
  const ms = parseStoredDate(date.start)
  return Number.isFinite(ms) ? ms : null
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight for a bare date; `Date.parse` for anything with a time. */
export function parseStoredDate(iso: string): number {
  const m = DATE_ONLY.exec(iso.trim())
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Date.parse(iso)
}

/** The title property of a database, which every database has exactly one of. */
export function titleProperty(database: Database): PropertyDef {
  return database.properties.find((p) => p.type === 'title') ?? database.properties[0]
}

export function findProperty(database: Database, propertyId: string): PropertyDef | undefined {
  return database.properties.find((p) => p.id === propertyId)
}

/** Property types whose values are computed rather than stored. */
export const COMPUTED_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  'formula', 'rollup', 'createdTime', 'lastEditedTime',
])

/** Operators offered for a given property type, in menu order. */
export function operatorsFor(type: PropertyType): FilterOperator[] {
  switch (type) {
    case 'checkbox':
      return ['checked', 'unchecked']
    case 'number':
      return ['is', 'isNot', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', 'isEmpty', 'isNotEmpty']
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return ['is', 'before', 'after', 'onOrBefore', 'onOrAfter', 'isWithin', 'isEmpty', 'isNotEmpty']
    case 'select':
    case 'status':
      return ['is', 'isNot', 'isEmpty', 'isNotEmpty']
    case 'multiSelect':
    case 'relation':
    case 'files':
      return ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty']
    default:
      return ['is', 'isNot', 'contains', 'doesNotContain', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty']
  }
}
