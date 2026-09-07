import { parse, referencedProperties, FormulaError, type Node } from './parser'
import type { Database, PropertyDef } from '@/state/database'

/**
 * The dependency graph.
 *
 * Formulas reference other properties by name, and those may themselves be
 * formulas, so a database has a little dataflow graph inside it. Two things
 * have to come out of it:
 *
 *   1. **Cycle detection at edit time.** `A = B + 1` alongside `B = A + 1` must
 *      be refused when it is typed, with a message naming the loop - not
 *      discovered later by hanging. The check runs against the graph the edit
 *      *would* create, so nothing invalid is ever committed to the store.
 *   2. **A topological order**, so recalculation visits each formula after
 *      everything it reads. Evaluating in schema order instead would read
 *      last-pass values and take several passes to settle, which is how a
 *      spreadsheet ends up with cells that are briefly wrong.
 *
 * Iterative depth-first search throughout. A recursive version is shorter and
 * blows the stack on a deep chain, which is exactly the input an adversarial
 * user supplies.
 */

export interface CompiledFormula {
  propertyId: string
  source: string
  ast: Node
  /** Property ids this formula reads, resolved from the names it mentions. */
  dependsOn: string[]
}

export interface FormulaGraph {
  /** Compiled formulas, keyed by property id. */
  formulas: Map<string, CompiledFormula>
  /** Property ids in evaluation order: every formula after its dependencies. */
  order: string[]
  /** Property id -> formula ids that read it, for incremental recalculation. */
  dependents: Map<string, string[]>
  /** Compile errors, keyed by property id. Never thrown - shown in the cell. */
  errors: Map<string, FormulaError>
}

/** Resolve a user-facing property name to its id, case-insensitively. */
function nameIndex(database: Database): Map<string, string> {
  const index = new Map<string, string>()
  for (const property of database.properties) {
    index.set(property.name.toLowerCase(), property.id)
  }
  return index
}

export function buildGraph(database: Database): FormulaGraph {
  const byName = nameIndex(database)
  const formulas = new Map<string, CompiledFormula>()
  const errors = new Map<string, FormulaError>()

  for (const property of database.properties) {
    if (property.type !== 'formula') continue
    const source = property.formula ?? ''
    if (!source.trim()) continue
    try {
      const ast = parse(source)
      const dependsOn = referencedProperties(ast)
        .map((name) => byName.get(name.toLowerCase()))
        .filter((id): id is string => Boolean(id))
      formulas.set(property.id, { propertyId: property.id, source, ast, dependsOn })
    } catch (error) {
      // A broken formula must not take the rest of the database down with it,
      // so the error is stored and rendered in that one cell.
      errors.set(property.id, error instanceof FormulaError ? error : new FormulaError(String(error), 0, 0))
    }
  }

  const dependents = new Map<string, string[]>()
  for (const formula of formulas.values()) {
    for (const dependency of formula.dependsOn) {
      const list = dependents.get(dependency)
      if (list) list.push(formula.propertyId)
      else dependents.set(dependency, [formula.propertyId])
    }
  }

  return { formulas, order: topologicalOrder(formulas), dependents, errors }
}

/**
 * Kahn's algorithm over the formula properties only.
 *
 * Non-formula properties are sources: they have no dependencies and cannot
 * change during a pass, so they never need to appear in the ordering.
 */
export function topologicalOrder(formulas: Map<string, CompiledFormula>): string[] {
  const indegree = new Map<string, number>()
  const edges = new Map<string, string[]>()

  for (const id of formulas.keys()) indegree.set(id, 0)

  for (const formula of formulas.values()) {
    for (const dependency of formula.dependsOn) {
      if (!formulas.has(dependency)) continue // a plain column, not a node
      edges.set(dependency, [...(edges.get(dependency) ?? []), formula.propertyId])
      indegree.set(formula.propertyId, (indegree.get(formula.propertyId) ?? 0) + 1)
    }
  }

  const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  const order: string[] = []

  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const next of edges.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  // Anything left has a non-zero indegree it can never shed: it is in a cycle.
  // Appending them keeps the order total; `findCycle` is what actually reports
  // the problem, and evaluation refuses to run on a cyclic graph anyway.
  for (const id of formulas.keys()) {
    if (!order.includes(id)) order.push(id)
  }

  return order
}

export interface CycleReport {
  /** Property ids forming the loop, in order, first repeated at the end. */
  cycle: string[]
  message: string
}

/**
 * Find a cycle, if there is one.
 *
 * Iterative DFS with an explicit stack and a three-colour marking. Recursion
 * would be half the length and would blow the stack on a long chain - which is
 * the precise input someone is holding when they discover this feature.
 */
export function findCycle(
  formulas: Map<string, CompiledFormula>,
  nameOf: (id: string) => string,
): CycleReport | null {
  const WHITE = 0, GREY = 1, BLACK = 2
  const colour = new Map<string, number>()
  for (const id of formulas.keys()) colour.set(id, WHITE)

  for (const root of formulas.keys()) {
    if (colour.get(root) !== WHITE) continue

    const path: string[] = []
    const stack: Array<{ id: string; nextIndex: number }> = [{ id: root, nextIndex: 0 }]
    colour.set(root, GREY)
    path.push(root)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const deps = (formulas.get(frame.id)?.dependsOn ?? []).filter((d) => formulas.has(d))

      if (frame.nextIndex >= deps.length) {
        colour.set(frame.id, BLACK)
        stack.pop()
        path.pop()
        continue
      }

      const next = deps[frame.nextIndex++]
      const state = colour.get(next)

      if (state === GREY) {
        // Back edge: the loop is everything from `next` onward in the path.
        const from = path.indexOf(next)
        const cycle = [...path.slice(from), next]
        return {
          cycle,
          message: cycle.length === 2
            ? `"${nameOf(cycle[0])}" refers to itself.`
            : `These formulas depend on each other in a loop: ${cycle.map(nameOf).join(' → ')}.`,
        }
      }

      if (state === WHITE) {
        colour.set(next, GREY)
        path.push(next)
        stack.push({ id: next, nextIndex: 0 })
      }
    }
  }

  return null
}

/**
 * Would this edit create a cycle?
 *
 * Checked against the graph the edit *would* produce, before it is committed,
 * so an invalid formula never reaches the store. Refusing at edit time is the
 * difference between a clear message and a spreadsheet that hangs.
 */
export function validateFormula(
  database: Database,
  propertyId: string,
  source: string,
): { ok: true } | { ok: false; message: string; start?: number; end?: number } {
  let ast: Node
  try {
    ast = parse(source)
  } catch (error) {
    if (error instanceof FormulaError) {
      return { ok: false, message: error.message, start: error.start, end: error.end }
    }
    return { ok: false, message: String(error) }
  }

  const byName = nameIndex(database)
  const dependsOn = referencedProperties(ast)
    .map((name) => byName.get(name.toLowerCase()))
    .filter((id): id is string => Boolean(id))

  // Referencing something that does not exist is worth saying plainly, rather
  // than silently evaluating to empty forever.
  const unknown = referencedProperties(ast).filter((name) => !byName.has(name.toLowerCase()))
  if (unknown.length > 0) {
    return { ok: false, message: `There is no property called "${unknown[0]}".` }
  }

  const candidate = new Map<string, CompiledFormula>()
  for (const property of database.properties) {
    if (property.type !== 'formula' || property.id === propertyId) continue
    const existing = property.formula?.trim()
    if (!existing) continue
    try {
      const parsed = parse(existing)
      candidate.set(property.id, {
        propertyId: property.id,
        source: existing,
        ast: parsed,
        dependsOn: referencedProperties(parsed)
          .map((name) => byName.get(name.toLowerCase()))
          .filter((id): id is string => Boolean(id)),
      })
    } catch {
      // An already-broken sibling cannot participate in a cycle.
    }
  }
  candidate.set(propertyId, { propertyId, source, ast, dependsOn })

  const nameOf = (id: string) => database.properties.find((p) => p.id === id)?.name ?? id
  const cycle = findCycle(candidate, nameOf)
  if (cycle) return { ok: false, message: cycle.message }

  return { ok: true }
}

/**
 * Formula properties that must be recomputed after `changed` changes.
 *
 * Transitive closure over the dependents map, returned in topological order so
 * a caller can evaluate the list straight through in one pass.
 */
export function affectedBy(graph: FormulaGraph, changed: string[]): string[] {
  const dirty = new Set<string>()
  const queue = [...changed]

  while (queue.length > 0) {
    const id = queue.shift()!
    for (const dependent of graph.dependents.get(id) ?? []) {
      if (dirty.has(dependent)) continue
      dirty.add(dependent)
      queue.push(dependent)
    }
  }

  return graph.order.filter((id) => dirty.has(id))
}

export function formulaProperties(database: Database): PropertyDef[] {
  return database.properties.filter((p) => p.type === 'formula')
}
