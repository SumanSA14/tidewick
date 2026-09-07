import type { WorkspaceState } from '@/state/types'
import type { Page } from '@/state/blocks'
import {
  findProperty, isEmptyValue, readString, readNumber, readDate, readStringArray,
  readBoolean, dateToMillis, titleProperty,
  type Database, type FilterNode, type FilterOperator, type PropertyDef,
  type PropertyValue, type SortRule, type View,
} from '@/state/database'
import { evaluateRow, toPropertyValue } from '@/formula/runtime'

/**
 * The query engine: filter, sort, group.
 *
 * Pure and free of React, so it can be tested exhaustively and, in Phase 4,
 * called from inside the derivation worker. The island needs the *same* answer
 * the Table view shows - a board column and a region of the isle are the same
 * query - so this cannot live in a component.
 *
 * Section 6.3 requires compound filters with AND/OR groups, multi-level sorts
 * and grouping, over 500 rows inside a 16 ms frame. Filtering and sorting 500
 * rows costs microseconds; the frame budget is spent in rendering, which is why
 * the Table view windows its output rather than mounting every row.
 */

export interface RowGroup {
  /** Stable key: an option id, a raw value, or the empty-group sentinel. */
  key: string
  label: string
  /** Palette token for select-like groups. */
  colour?: string
  rows: string[]
}

export interface QueryResult {
  /** Row page ids, filtered and sorted. */
  rows: string[]
  /** Present only when the view groups. Order follows the property options. */
  groups: RowGroup[] | null
  /** Rows before filtering, for "3 of 120" counts. */
  total: number
}

export const EMPTY_GROUP_KEY = '__empty__'

/** Read a property value for a row, computing the derived types. */
export function valueOf(
  state: WorkspaceState,
  page: Page,
  property: PropertyDef,
): PropertyValue {
  switch (property.type) {
    case 'title':
      return page.title
    case 'createdTime':
      return { start: new Date(page.createdAt).toISOString(), hasTime: true }
    case 'lastEditedTime':
      return { start: new Date(page.updatedAt).toISOString(), hasTime: true }
    case 'rollup':
      return computeRollup(state, page, property)
    case 'formula': {
      // Formulas are evaluated per row, in topological order, and cached on the
      // page identity - see formula/runtime.ts. Filters and sorts therefore see
      // the same value the cell shows, with no separate code path.
      const database = page.databaseId ? state.databases[page.databaseId] : undefined
      if (!database) return null
      return toPropertyValue(evaluateRow(state, database, page).get(property.id) ?? null)
    }
    default:
      return page.properties?.[property.id] ?? null
  }
}

/**
 * Rollups, evaluated eagerly.
 *
 * Phase 5 replaces this with the dependency-graph version that recomputes only
 * transitive dependents. It is here now because Board and Table are far more
 * useful with counts, and because the shape of the answer will not change.
 */
function computeRollup(state: WorkspaceState, page: Page, property: PropertyDef): PropertyValue {
  const { rollupRelationId, rollupTargetPropertyId, rollupFunction } = property
  if (!rollupRelationId || !rollupFunction) return null

  const relatedIds = readStringArray(page.properties?.[rollupRelationId])
  const relatedPages = relatedIds.map((id) => state.pages[id]).filter(Boolean)

  if (rollupFunction === 'countAll') return relatedPages.length

  const relationDef = findProperty(
    state.databases[page.databaseId ?? ''] ?? ({ properties: [] } as unknown as Database),
    rollupRelationId,
  )
  const targetDb = relationDef?.relationDatabaseId ? state.databases[relationDef.relationDatabaseId] : undefined
  const target = targetDb && rollupTargetPropertyId ? findProperty(targetDb, rollupTargetPropertyId) : undefined
  if (!target) return null

  const values = relatedPages.map((p) => valueOf(state, p, target))

  switch (rollupFunction) {
    case 'countEmpty': return values.filter(isEmptyValue).length
    case 'countNotEmpty': return values.filter((v) => !isEmptyValue(v)).length
    case 'countUnique': return new Set(values.map(readString)).size
    case 'sum': return sumOf(values)
    case 'average': {
      const numbers = values.map(readNumber).filter((n): n is number => n !== null)
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null
    }
    case 'min': {
      const numbers = values.map(readNumber).filter((n): n is number => n !== null)
      return numbers.length ? Math.min(...numbers) : null
    }
    case 'max': {
      const numbers = values.map(readNumber).filter((n): n is number => n !== null)
      return numbers.length ? Math.max(...numbers) : null
    }
    case 'earliest':
    case 'latest': {
      const times = values.map(dateToMillis).filter((n): n is number => n !== null)
      if (!times.length) return null
      const ms = rollupFunction === 'earliest' ? Math.min(...times) : Math.max(...times)
      return { start: new Date(ms).toISOString() }
    }
    case 'percentComplete': {
      if (!values.length) return null
      const done = values.filter((v) => readBoolean(v) || isCompleteStatus(target, v)).length
      return done / values.length
    }
    case 'showOriginal':
      return values.map(readString).join(', ')
    default:
      return null
  }
}

function sumOf(values: PropertyValue[]): number {
  return values.reduce<number>((total, v) => total + (readNumber(v) ?? 0), 0)
}

function isCompleteStatus(property: PropertyDef, value: PropertyValue): boolean {
  if (property.type !== 'status') return false
  const option = property.options?.find((o) => o.id === value || o.name === value)
  return option?.group === 'complete'
}

// --- filtering -------------------------------------------------------------

export function matchesFilter(
  state: WorkspaceState,
  database: Database,
  page: Page,
  node: FilterNode,
): boolean {
  if (node.kind === 'group') {
    // An empty group matches everything. The alternative - an empty AND being
    // vacuously true but an empty OR being vacuously false - means adding a
    // filter group hides every row until you finish configuring it.
    if (node.children.length === 0) return true
    return node.op === 'and'
      ? node.children.every((child) => matchesFilter(state, database, page, child))
      : node.children.some((child) => matchesFilter(state, database, page, child))
  }

  const property = findProperty(database, node.propertyId)
  if (!property) return true

  const value = valueOf(state, page, property)
  return applyOperator(property, value, node.operator, node.value)
}

export function applyOperator(
  property: PropertyDef,
  value: PropertyValue,
  operator: FilterOperator,
  operand: PropertyValue | undefined,
): boolean {
  switch (operator) {
    case 'isEmpty': return isEmptyValue(value)
    case 'isNotEmpty': return !isEmptyValue(value)
    case 'checked': return readBoolean(value)
    case 'unchecked': return !readBoolean(value)
  }

  // Every remaining operator compares against something. A rule with no operand
  // is half-written, and hiding every row while the user is still typing it is
  // hostile - so an empty operand matches everything.
  if (isEmptyValue(operand)) return true

  if (property.type === 'multiSelect' || property.type === 'relation' || property.type === 'files') {
    const items = readStringArray(value)
    const needle = readString(operand)
    switch (operator) {
      case 'contains': return items.includes(needle)
      case 'doesNotContain': return !items.includes(needle)
      default: return true
    }
  }

  if (property.type === 'number') {
    const a = readNumber(value)
    const b = readNumber(operand)
    if (a === null || b === null) return false
    switch (operator) {
      case 'is': return a === b
      case 'isNot': return a !== b
      case 'greaterThan': return a > b
      case 'lessThan': return a < b
      case 'greaterOrEqual': return a >= b
      case 'lessOrEqual': return a <= b
      default: return true
    }
  }

  if (property.type === 'date' || property.type === 'createdTime' || property.type === 'lastEditedTime') {
    const a = dateToMillis(value)
    if (a === null) return false
    if (operator === 'isWithin') {
      const range = readDate(operand)
      if (!range?.end) return true
      const from = Date.parse(range.start)
      const to = Date.parse(range.end)
      return a >= from && a <= to
    }
    const b = dateToMillis(operand)
    if (b === null) return false
    // Day-granularity comparison: "is 14 March" must match 14 March at any
    // time of day, not only midnight.
    const dayA = startOfDay(a)
    const dayB = startOfDay(b)
    switch (operator) {
      case 'is': return dayA === dayB
      case 'isNot': return dayA !== dayB
      case 'before': return dayA < dayB
      case 'after': return dayA > dayB
      case 'onOrBefore': return dayA <= dayB
      case 'onOrAfter': return dayA >= dayB
      default: return true
    }
  }

  const text = readString(value).toLowerCase()
  const needle = readString(operand).toLowerCase()
  switch (operator) {
    case 'is': return text === needle
    case 'isNot': return text !== needle
    case 'contains': return text.includes(needle)
    case 'doesNotContain': return !text.includes(needle)
    case 'startsWith': return text.startsWith(needle)
    case 'endsWith': return text.endsWith(needle)
    default: return true
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// --- sorting ---------------------------------------------------------------

/**
 * Compare two rows for one sort rule.
 *
 * Empty values always sort last regardless of direction. Treating them as
 * "smallest" means reversing a sort floats every unfilled row to the top, which
 * is never what anyone wanted from clicking a column header twice.
 */
function compareBy(
  state: WorkspaceState,
  a: Page,
  b: Page,
  property: PropertyDef,
  direction: SortRule['direction'],
): number {
  const va = valueOf(state, a, property)
  const vb = valueOf(state, b, property)

  const emptyA = isEmptyValue(va)
  const emptyB = isEmptyValue(vb)
  if (emptyA && emptyB) return 0
  if (emptyA) return 1
  if (emptyB) return -1

  const sign = direction === 'asc' ? 1 : -1

  switch (property.type) {
    case 'number':
      return sign * ((readNumber(va) ?? 0) - (readNumber(vb) ?? 0))
    case 'checkbox':
      return sign * (Number(readBoolean(va)) - Number(readBoolean(vb)))
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return sign * ((dateToMillis(va) ?? 0) - (dateToMillis(vb) ?? 0))
    case 'select':
    case 'status': {
      // Sort by the option order the user arranged, not alphabetically - a
      // status of To-do, In progress, Complete is meaningless in any other
      // order and alphabetical would put Complete first.
      const order = property.options ?? []
      const ia = order.findIndex((o) => o.id === va || o.name === va)
      const ib = order.findIndex((o) => o.id === vb || o.name === vb)
      return sign * ((ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib))
    }
    default:
      return sign * COLLATOR.compare(readString(va), readString(vb))
  }
}

/**
 * One shared collator.
 *
 * `String.localeCompare(other, undefined, options)` builds a fresh
 * Intl.Collator on every single call in most engines, and a sort over 500 rows
 * makes about 4,500 of them. Hoisting it is the difference between a text sort
 * being free and being the most expensive thing in the query.
 *
 * Numeric collation so "Problem 2" sorts before "Problem 10", and base
 * sensitivity so case does not split otherwise-identical titles.
 */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// --- grouping --------------------------------------------------------------

function groupKeysFor(property: PropertyDef): Array<{ key: string; label: string; colour?: string }> {
  if (property.options?.length) {
    return property.options.map((o) => ({ key: o.id, label: o.name, colour: o.colour }))
  }
  return []
}

function groupKeyOf(property: PropertyDef, value: PropertyValue): string {
  if (isEmptyValue(value)) return EMPTY_GROUP_KEY
  if (property.type === 'multiSelect' || property.type === 'relation') {
    return readStringArray(value)[0] ?? EMPTY_GROUP_KEY
  }
  if (property.type === 'checkbox') return readBoolean(value) ? 'true' : 'false'
  return readString(value)
}

// --- the query -------------------------------------------------------------

export function runQuery(state: WorkspaceState, database: Database, view: View): QueryResult {
  const pages = database.rows
    .map((id) => state.pages[id])
    .filter((p): p is Page => Boolean(p) && !p.trashed)

  const filtered = pages.filter((page) => matchesFilter(state, database, page, view.filter))

  let sorted = filtered
  if (view.sorts.length) {
    // Precompute the database order once. Calling rows.indexOf() inside the
    // comparator instead is O(n) per comparison and therefore O(n^2 log n)
    // overall - it cost 8 ms on 500 rows, forty times the sorted-with-a-map
    // figure, and it is invisible until you actually measure it.
    const order = new Map<string, number>()
    database.rows.forEach((id, index) => order.set(id, index))

    // Resolve the sort properties once too, for the same reason: findProperty
    // is a linear scan of the schema, and calling it per comparison was still
    // costing 5 ms on 500 rows after the indexOf fix.
    const rules = view.sorts
      .map((rule) => ({ property: findProperty(database, rule.propertyId), direction: rule.direction }))
      .filter((r): r is { property: PropertyDef; direction: SortRule['direction'] } => r.property !== undefined)

    sorted = [...filtered].sort((a, b) => {
      for (const rule of rules) {
        const result = compareBy(state, a, b, rule.property, rule.direction)
        if (result !== 0) return result
      }
      // Stable tail-break on the database order, so equal rows do not shuffle
      // between renders.
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    })
  }

  const rows = sorted.map((p) => p.id)

  const groupProperty = view.groupBy ? findProperty(database, view.groupBy) : undefined
  if (!groupProperty) {
    return { rows, groups: null, total: pages.length }
  }

  const declared = groupKeysFor(groupProperty)
  const buckets = new Map<string, RowGroup>()

  // Seed the declared options first, so a Board shows an empty column for a
  // status nobody is using rather than silently dropping it.
  for (const g of declared) buckets.set(g.key, { ...g, rows: [] })

  for (const page of sorted) {
    const key = groupKeyOf(groupProperty, valueOf(state, page, groupProperty))
    let bucket = buckets.get(key)
    if (!bucket) {
      const option = groupProperty.options?.find((o) => o.id === key)
      bucket = {
        key,
        label: key === EMPTY_GROUP_KEY ? 'No ' + groupProperty.name.toLowerCase() : option?.name ?? key,
        colour: option?.colour,
        rows: [],
      }
      buckets.set(key, bucket)
    }
    bucket.rows.push(page.id)
  }

  // The empty group always sits last, whatever order it was created in.
  const groups = [...buckets.values()].filter((g) => g.key !== EMPTY_GROUP_KEY)
  const empty = buckets.get(EMPTY_GROUP_KEY)
  if (empty) groups.push(empty)

  return { rows, groups, total: pages.length }
}

/** Display name of a row, for views that show one line per row. */
export function rowTitle(state: WorkspaceState, database: Database, rowId: string): string {
  const page = state.pages[rowId]
  if (!page) return ''
  const property = titleProperty(database)
  return readString(valueOf(state, page, property))
}
