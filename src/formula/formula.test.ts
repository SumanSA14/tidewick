import { describe, it, expect } from 'vitest'
import { parse, tokenize, referencedProperties, FormulaError } from './parser'
import { evaluate, type FormulaValue, type EvalContext } from './evaluate'
import { buildGraph, findCycle, validateFormula, affectedBy, topologicalOrder } from './graph'
import type { Database, PropertyDef } from '@/state/database'

/**
 * The formula engine.
 *
 * Tested harder than anything else in the project, because a formula that is
 * quietly wrong is worse than one that fails: the number looks plausible, gets
 * used, and nobody finds out for weeks. Cycle detection gets its own section
 * for the same reason - it must refuse, and it must refuse *fast*.
 */

const NOW = new Date('2026-03-01T12:00:00Z')

function context(props: Record<string, FormulaValue> = {}): EvalContext {
  return {
    prop: (name) => props[name] ?? null,
    now: () => NOW,
  }
}

const run = (source: string, props: Record<string, FormulaValue> = {}) =>
  evaluate(parse(source), context(props))

describe('lexer', () => {
  it('reads numbers, strings and identifiers', () => {
    const tokens = tokenize('round(prop("A") * 1.5, 2)')
    expect(tokens.map((t) => t.kind)).toEqual([
      'identifier', 'punct', 'identifier', 'punct', 'string', 'punct',
      'operator', 'number', 'punct', 'number', 'punct', 'end',
    ])
  })

  it('accepts both quote styles and escapes', () => {
    expect(run(`"a\\"b"`)).toBe('a"b')
    expect(run(`'single'`)).toBe('single')
  })

  it('treats a lone = as ==, because it is always a typo', () => {
    expect(run('1 = 1')).toBe(true)
  })

  it('allows underscores as digit separators', () => {
    expect(run('1_000 + 1')).toBe(1001)
  })

  it('reports an unterminated string with a span', () => {
    try {
      tokenize('"never closed')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError)
      expect((error as FormulaError).message).toContain('closing quote')
    }
  })

  it('names the character it could not read', () => {
    expect(() => tokenize('1 $ 2')).toThrow(/\$/)
  })
})

describe('parser', () => {
  it('respects arithmetic precedence', () => {
    expect(run('2 + 3 * 4')).toBe(14)
    expect(run('(2 + 3) * 4')).toBe(20)
    expect(run('-2 + 3')).toBe(1)
    expect(run('2 - 3 - 4')).toBe(-5) // left associative
  })

  it('binds comparison looser than arithmetic', () => {
    expect(run('1 + 1 == 2')).toBe(true)
  })

  it('binds and/or looser than comparison', () => {
    expect(run('1 < 2 and 3 > 2')).toBe(true)
    expect(run('1 > 2 or 3 > 2')).toBe(true)
  })

  it('parses nested calls', () => {
    expect(run('max(min(5, 3), abs(-2))')).toBe(3)
  })

  it('rejects a bare identifier with a helpful suggestion', () => {
    expect(() => parse('Status')).toThrow(/prop\("Status"\)/)
  })

  it('rejects a computed property name', () => {
    // A dynamic column reference would make the dependency graph undecidable,
    // and undecidable means no cycle detection.
    expect(() => parse('prop(concat("St", "atus"))')).toThrow(/in quotes/)
  })

  it('reports trailing junk rather than ignoring it', () => {
    expect(() => parse('1 + 1)')).toThrow(/Unexpected/)
  })

  it('reports a formula that ends early', () => {
    expect(() => parse('1 +')).toThrow(/ended before it was finished/)
  })

  it('reports an unclosed bracket', () => {
    expect(() => parse('max(1, 2')).toThrow(/closing bracket/)
  })

  it('collects the properties a formula reads', () => {
    const ast = parse('if(prop("Done"), prop("Estimate") * 2, prop("Estimate"))')
    expect(referencedProperties(ast).sort()).toEqual(['Done', 'Estimate'])
  })
})

describe('evaluation', () => {
  it('reads properties', () => {
    expect(run('prop("Estimate") + 1', { Estimate: 41 })).toBe(42)
  })

  it('returns null for a property that is not set', () => {
    expect(run('prop("Nothing")')).toBeNull()
  })

  describe('if', () => {
    it('chooses a branch', () => {
      expect(run('if(true, "yes", "no")')).toBe('yes')
      expect(run('if(false, "yes", "no")')).toBe('no')
    })

    it('does not evaluate the branch it is not taking', () => {
      // Otherwise the guard is useless: this is the canonical way to avoid
      // dividing by a value you have just checked is missing.
      expect(run('if(empty(prop("X")), 0, 100 / prop("X"))', { X: null })).toBe(0)
    })
  })

  it('short-circuits and/or', () => {
    expect(run('not empty(prop("X")) and prop("X") > 3', { X: null })).toBe(false)
    expect(run('empty(prop("X")) or prop("X") > 3', { X: null })).toBe(true)
  })

  describe('text', () => {
    it('concatenates with + when either side is text', () => {
      expect(run('"a" + 1')).toBe('a1')
      expect(run('1 + "a"')).toBe('1a')
    })

    it('adds when both sides are numbers', () => {
      expect(run('1 + 1')).toBe(2)
    })

    it('slices and measures', () => {
      expect(run('slice("Placement", 0, 5)')).toBe('Place')
      expect(run('length("abc")')).toBe(3)
      expect(run('concat("a", "b", "c")')).toBe('abc')
    })
  })

  describe('numbers', () => {
    it('rounds to a given number of places', () => {
      expect(run('round(3.14159, 2)')).toBe(3.14)
      expect(run('floor(3.9)')).toBe(3)
      expect(run('ceil(3.1)')).toBe(4)
      expect(run('abs(-7)')).toBe(7)
    })

    it('sums, ignoring what is not a number', () => {
      expect(run('sum(1, 2, prop("Missing"), 3)')).toBe(6)
    })

    it('returns null rather than Infinity when min/max has nothing', () => {
      // Infinity would propagate silently through everything downstream.
      expect(run('min(prop("Missing"))')).toBeNull()
    })

    it('returns null for division by zero', () => {
      expect(run('1 / 0')).toBeNull()
      expect(run('1 % 0')).toBeNull()
    })

    it('trims floating point noise when shown as text', () => {
      expect(run('format(0.1 + 0.2)')).toBe('0.3')
    })

    it('refuses to do arithmetic on text, rather than guessing zero', () => {
      // A spreadsheet that turns "" into 0 is wrong in a way nobody notices.
      expect(() => run('prop("Name") * 2', { Name: 'Two Sum' })).toThrow(/needs to be a number/)
    })
  })

  describe('dates', () => {
    it('adds calendar units', () => {
      const result = run('dateAdd(now(), 1, "months")') as Date
      expect(result.getMonth()).toBe(3) // March -> April
    })

    it('clamps a month-end rollover instead of overflowing', () => {
      const jan31 = new Date(2026, 0, 31)
      const result = evaluate(parse('dateAdd(prop("D"), 1, "months")'), context({ D: jan31 })) as Date
      expect(result.getMonth()).toBe(1) // February, not March
    })

    it('measures the gap in whole units', () => {
      expect(run('dateBetween(prop("B"), prop("A"), "days")', {
        A: new Date('2026-03-01'), B: new Date('2026-03-08'),
      })).toBe(7)
    })

    it('does not count an incomplete month', () => {
      expect(run('dateBetween(prop("B"), prop("A"), "months")', {
        A: new Date(2026, 0, 31), B: new Date(2026, 1, 1),
      })).toBe(0)
    })

    it('formats with a user-chosen pattern', () => {
      const d = new Date(2026, 2, 14)
      expect(evaluate(parse('formatDate(prop("D"), "YYYY-MM-DD")'), context({ D: d }))).toBe('2026-03-14')
      expect(evaluate(parse('formatDate(prop("D"), "D MMM YYYY")'), context({ D: d }))).toBe('14 Mar 2026')
      expect(evaluate(parse('formatDate(prop("D"), "DDDD")'), context({ D: d }))).toBe('Saturday')
    })

    it('rejects an unknown unit by name', () => {
      expect(() => run('dateAdd(now(), 1, "fortnights")')).toThrow(/fortnights/)
    })
  })

  describe('errors', () => {
    it('names an unknown function', () => {
      expect(() => run('frobnicate(1)')).toThrow(/no function called "frobnicate"/)
    })

    it('reports the wrong number of arguments', () => {
      expect(() => run('round()')).toThrow(/takes 1 to 2 arguments, but got 0/)
      expect(() => run('if(true, 1)')).toThrow(/takes 3 arguments, but got 2/)
    })

    it('carries a span so the editor can underline the problem', () => {
      try {
        parse('1 + $')
        expect.unreachable()
      } catch (error) {
        const e = error as FormulaError
        expect(e.start).toBe(4)
        expect(e.end).toBe(5)
      }
    })
  })
})

// --- the dependency graph --------------------------------------------------

function database(formulas: Record<string, string>, plain: string[] = []): Database {
  const properties: PropertyDef[] = [
    { id: 'title', name: 'Name', type: 'title' },
    ...plain.map((name) => ({ id: name.toLowerCase(), name, type: 'number' as const })),
    ...Object.entries(formulas).map(([name, formula]) => ({
      id: name.toLowerCase(), name, type: 'formula' as const, formula,
    })),
  ]
  return { id: 'db', name: 'Test', properties, views: [], rows: [], createdAt: 0 }
}

describe('dependency graph', () => {
  it('resolves property names to ids', () => {
    const db = database({ Total: 'prop("Estimate") * 2' }, ['Estimate'])
    const graph = buildGraph(db)
    expect(graph.formulas.get('total')!.dependsOn).toEqual(['estimate'])
  })

  it('is case-insensitive about property names', () => {
    const db = database({ Total: 'prop("estimate") * 2' }, ['Estimate'])
    expect(buildGraph(db).formulas.get('total')!.dependsOn).toEqual(['estimate'])
  })

  it('orders a formula after everything it reads', () => {
    const db = database({
      C: 'prop("B") + 1',
      B: 'prop("A") + 1',
      A: '1',
    })
    const order = buildGraph(db).order
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('keeps a broken formula from taking the database down', () => {
    const db = database({ Broken: 'this is not a formula', Fine: '1 + 1' })
    const graph = buildGraph(db)
    expect(graph.errors.has('broken')).toBe(true)
    expect(graph.formulas.has('fine')).toBe(true)
  })

  describe('cycle detection', () => {
    const nameOf = (id: string) => id.toUpperCase()

    it('finds a two-formula loop', () => {
      const db = database({ A: 'prop("B") + 1', B: 'prop("A") + 1' })
      const cycle = findCycle(buildGraph(db).formulas, nameOf)
      expect(cycle).not.toBeNull()
      expect(cycle!.message).toMatch(/loop/)
    })

    it('finds a self-reference and says so plainly', () => {
      const db = database({ A: 'prop("A") + 1' })
      const cycle = findCycle(buildGraph(db).formulas, nameOf)
      expect(cycle!.message).toBe('"A" refers to itself.')
    })

    it('finds a long loop', () => {
      const db = database({
        A: 'prop("B")', B: 'prop("C")', C: 'prop("D")', D: 'prop("A")',
      })
      expect(findCycle(buildGraph(db).formulas, nameOf)).not.toBeNull()
    })

    it('does not cry cycle over a diamond', () => {
      // A -> B, A -> C, B -> D, C -> D is a perfectly legal shape and a naive
      // "have I seen this node" check calls it a loop.
      const db = database({
        D: '1',
        B: 'prop("D")',
        C: 'prop("D")',
        A: 'prop("B") + prop("C")',
      })
      expect(findCycle(buildGraph(db).formulas, nameOf)).toBeNull()
    })

    it('never hangs, on a graph deep enough to blow a recursive stack', () => {
      const formulas: Record<string, string> = { F0: '1' }
      for (let i = 1; i < 12_000; i++) formulas[`F${i}`] = `prop("F${i - 1}") + 1`
      // Close the loop at the very end, so detection must walk the whole chain.
      formulas.F0 = 'prop("F11999")'

      const graph = buildGraph(database(formulas))
      const started = performance.now()
      const cycle = findCycle(graph.formulas, nameOf)
      const elapsed = performance.now() - started

      expect(cycle).not.toBeNull()
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe('validateFormula, at edit time', () => {
    it('accepts a formula that reads a plain column', () => {
      const db = database({}, ['Estimate'])
      expect(validateFormula(db, 'total', 'prop("Estimate") * 2')).toEqual({ ok: true })
    })

    it('refuses a formula that would close a loop, before it is committed', () => {
      const db = database({ A: 'prop("B") + 1', B: '1' })
      const result = validateFormula(db, 'b', 'prop("A") + 1')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/loop|itself/)
    })

    it('refuses a self-reference', () => {
      const db = database({ A: '1' })
      const result = validateFormula(db, 'a', 'prop("A") + 1')
      expect(result.ok).toBe(false)
    })

    it('names a property that does not exist', () => {
      const db = database({}, ['Estimate'])
      const result = validateFormula(db, 'x', 'prop("Estimeat")')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('Estimeat')
    })

    it('returns a span for a syntax error', () => {
      const db = database({}, ['Estimate'])
      const result = validateFormula(db, 'x', '1 + $')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.start).toBe(4)
    })
  })

  describe('incremental recalculation', () => {
    it('returns only the transitive dependents, in evaluation order', () => {
      const db = database({
        B: 'prop("A") + 1',
        C: 'prop("B") + 1',
        Unrelated: '99',
      }, ['A'])
      const graph = buildGraph(db)
      const affected = affectedBy(graph, ['a'])
      expect(affected).toEqual(['b', 'c'])
      expect(affected).not.toContain('unrelated')
    })

    it('returns nothing when the change touches no formula', () => {
      const db = database({ B: 'prop("A") + 1' }, ['A', 'Other'])
      expect(affectedBy(buildGraph(db), ['other'])).toEqual([])
    })

    it('does not loop forever on a cyclic graph', () => {
      const db = database({ A: 'prop("B")', B: 'prop("A")' })
      const graph = buildGraph(db)
      expect(() => affectedBy(graph, ['a'])).not.toThrow()
    })

    it('produces a total order even when a cycle exists', () => {
      const formulas = new Map(buildGraph(database({ A: 'prop("B")', B: 'prop("A")' })).formulas)
      expect(topologicalOrder(formulas).sort()).toEqual(['a', 'b'])
    })
  })
})

describe('the Phase 5 gate', () => {
  it('recalculates 1,000 rows in well under 50 ms', () => {
    // Three chained formulas per row, so this is 3,000 evaluations plus the
    // graph walk - the shape the acceptance criterion is really asking about.
    const db = database({
      Doubled: 'prop("Estimate") * 2',
      Banded: 'if(prop("Doubled") > 100, "large", "small")',
      Label: 'concat(prop("Banded"), " (", format(prop("Doubled")), ")")',
    }, ['Estimate'])

    const graph = buildGraph(db)
    const order = graph.order
    const rows = Array.from({ length: 1000 }, (_, i) => ({ Estimate: i % 120 }))

    const started = performance.now()
    let checksum = 0
    for (const row of rows) {
      const values: Record<string, FormulaValue> = { ...row }
      const ctx: EvalContext = {
        prop: (name) => values[name] ?? null,
        now: () => NOW,
      }
      for (const id of order) {
        const formula = graph.formulas.get(id)
        if (!formula) continue
        const name = db.properties.find((p) => p.id === id)!.name
        values[name] = evaluate(formula.ast, ctx)
      }
      checksum += String(values.Label).length
    }
    const elapsed = performance.now() - started

    expect(checksum).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50)
  })
})
