import type { WorkspaceState } from '@/state/types'
import type { Page } from '@/state/blocks'
import {
  readString, readNumber, readDate, readStringArray, readBoolean,
  type Database, type PropertyDef, type PropertyValue,
} from '@/state/database'
import { buildGraph, type FormulaGraph } from './graph'
import { evaluate, type EvalContext, type FormulaValue } from './evaluate'
import { FormulaError } from './parser'

/**
 * Running formulas against real rows.
 *
 * Two memoisation layers, both keyed on object identity, which works precisely
 * because the store is immutable: Immer hands back a new `Database` only when
 * the schema actually changed, and a new `Page` only when that row changed. So
 * a WeakMap keyed on those objects is a correct cache with no invalidation
 * logic to get wrong - the identity *is* the invalidation.
 *
 * Formulas currently read properties of their own row only. That is what makes
 * per-page caching sound; a formula that walked a relation would depend on
 * pages other than its own and would need a different key. Phase 5 rollups go
 * through `query.ts` instead, which is why they are not part of this graph.
 */

const graphCache = new WeakMap<Database, FormulaGraph>()
const rowCache = new WeakMap<Page, { graph: FormulaGraph; values: Map<string, FormulaValue> }>()

export function graphFor(database: Database): FormulaGraph {
  const cached = graphCache.get(database)
  if (cached) return cached
  const graph = buildGraph(database)
  graphCache.set(database, graph)
  return graph
}

/**
 * Every formula value for one row, evaluated in topological order.
 *
 * One pass, not several: the order guarantees each formula runs after
 * everything it reads, so no value is ever computed from a stale one.
 */
export function evaluateRow(
  state: WorkspaceState,
  database: Database,
  page: Page,
  now: Date = new Date(),
): Map<string, FormulaValue> {
  const graph = graphFor(database)

  const cached = rowCache.get(page)
  if (cached && cached.graph === graph) return cached.values

  const byName = new Map<string, PropertyDef>()
  for (const property of database.properties) byName.set(property.name.toLowerCase(), property)

  const computed = new Map<string, FormulaValue>()

  const context: EvalContext = {
    now: () => now,
    prop: (name) => {
      const property = byName.get(name.toLowerCase())
      if (!property) return null
      if (property.type === 'formula') return computed.get(property.id) ?? null
      return toFormulaValue(state, page, property)
    },
  }

  for (const id of graph.order) {
    const formula = graph.formulas.get(id)
    if (!formula) continue
    try {
      computed.set(id, evaluate(formula.ast, context))
    } catch (error) {
      // One broken formula shows an error in its own cell; the rest of the row
      // still computes. A single bad expression must not blank a whole table.
      computed.set(id, error instanceof FormulaError ? `#${error.message}` : '#error')
    }
  }

  rowCache.set(page, { graph, values: computed })
  return computed
}

/** Translate a stored property value into something the evaluator understands. */
function toFormulaValue(state: WorkspaceState, page: Page, property: PropertyDef): FormulaValue {
  switch (property.type) {
    case 'title': return page.title
    case 'createdTime': return new Date(page.createdAt)
    case 'lastEditedTime': return new Date(page.updatedAt)
    case 'checkbox': return readBoolean(page.properties?.[property.id])
    case 'number': return readNumber(page.properties?.[property.id])
    case 'date': {
      const date = readDate(page.properties?.[property.id])
      if (!date) return null
      const ms = Date.parse(date.start)
      return Number.isFinite(ms) ? new Date(ms) : null
    }
    case 'multiSelect':
    case 'files':
      return readStringArray(page.properties?.[property.id])
    case 'relation': {
      // Relations evaluate to the titles of what they point at, which is what
      // makes concat() and length() over a relation do something useful.
      return readStringArray(page.properties?.[property.id])
        .map((id) => state.pages[id]?.title ?? '')
        .filter(Boolean)
    }
    case 'select':
    case 'status': {
      const raw = readString(page.properties?.[property.id])
      // Options are stored by id; a formula wants the name a person can read.
      const option = property.options?.find((o) => o.id === raw)
      return option?.name ?? raw
    }
    default:
      return readString(page.properties?.[property.id])
  }
}

/**
 * Turn a formula result into something a cell can render.
 *
 * Dates stay dates so the cell can format them per the user's locale; lists
 * become text because there is no list column to put them in.
 */
export function toPropertyValue(value: FormulaValue): PropertyValue {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return { start: value.toISOString(), hasTime: true }
  if (Array.isArray(value)) return value.map((v) => (v === null ? '' : String(v)))
  return value
}

/** Compile errors for a database, so the schema editor can show them. */
export function formulaErrors(database: Database): Map<string, FormulaError> {
  return graphFor(database).errors
}
