import { FormulaError, type Node } from './parser'

/**
 * The evaluator.
 *
 * Five types, per Section 6.4: number, string, boolean, date, list. Dates are
 * real `Date` objects rather than strings, so `dateBetween` does not have to
 * guess at a format, and lists exist mostly so rollups and multi-selects have
 * something honest to evaluate to.
 *
 * Coercion is deliberately narrow. A spreadsheet that quietly turns "" into 0
 * produces answers that are wrong in a way nobody notices for months, so
 * arithmetic on something that is not a number is an error with a message
 * rather than a silent zero. The one exception is `empty`, whose whole job is
 * to be asked about missing values.
 */

export type FormulaValue = number | string | boolean | Date | FormulaValue[] | null

export interface EvalContext {
  /** Read a property of the row being evaluated, by user-facing name. */
  prop(name: string): FormulaValue
  /** Injected so tests are deterministic and `now()` is stable within a pass. */
  now(): Date
}

export function evaluate(node: Node, context: EvalContext): FormulaValue {
  switch (node.type) {
    case 'number': return node.value
    case 'string': return node.value
    case 'boolean': return node.value
    case 'prop': return context.prop(node.name)
    case 'unary': return evalUnary(node, context)
    case 'binary': return evalBinary(node, context)
    case 'call': return evalCall(node, context)
  }
}

function evalUnary(node: Extract<Node, { type: 'unary' }>, context: EvalContext): FormulaValue {
  const value = evaluate(node.operand, context)
  if (node.op === 'not') return !truthy(value)
  return -asNumber(value, node, 'negate')
}

function evalBinary(node: Extract<Node, { type: 'binary' }>, context: EvalContext): FormulaValue {
  // Short-circuit, so `and`/`or` can guard against errors on the other side -
  // `not empty(prop("X")) and prop("X") > 3` has to be writable.
  if (node.op === 'and') {
    return truthy(evaluate(node.left, context)) ? truthy(evaluate(node.right, context)) : false
  }
  if (node.op === 'or') {
    return truthy(evaluate(node.left, context)) ? true : truthy(evaluate(node.right, context))
  }

  const left = evaluate(node.left, context)
  const right = evaluate(node.right, context)

  switch (node.op) {
    case '==': return equals(left, right)
    case '!=': return !equals(left, right)
    case '<': case '>': case '<=': case '>=': {
      const a = comparable(left, node)
      const b = comparable(right, node)
      switch (node.op) {
        case '<': return a < b
        case '>': return a > b
        case '<=': return a <= b
        default: return a >= b
      }
    }
    case '+': {
      // `+` concatenates when either side is text, which is what people expect
      // from a formula bar and what makes concat() optional.
      if (typeof left === 'string' || typeof right === 'string') {
        return asString(left) + asString(right)
      }
      return asNumber(left, node, 'add') + asNumber(right, node, 'add')
    }
    case '-': return asNumber(left, node, 'subtract') - asNumber(right, node, 'subtract')
    case '*': return asNumber(left, node, 'multiply') * asNumber(right, node, 'multiply')
    case '/': {
      const divisor = asNumber(right, node, 'divide')
      // Returning null rather than Infinity: a division by zero in a table
      // cell is a missing answer, not an enormous one.
      if (divisor === 0) return null
      return asNumber(left, node, 'divide') / divisor
    }
    case '%': {
      const divisor = asNumber(right, node, 'divide')
      if (divisor === 0) return null
      return asNumber(left, node, 'divide') % divisor
    }
    default:
      throw new FormulaError(`I do not know the operator "${node.op}".`, node.start, node.end)
  }
}

type Fn = (args: FormulaValue[], node: Extract<Node, { type: 'call' }>, context: EvalContext) => FormulaValue

const FUNCTIONS: Record<string, { arity: [number, number]; fn: Fn }> = {
  if: {
    arity: [3, 3],
    // Evaluated lazily below; this entry exists for arity checking and docs.
    fn: (args) => (truthy(args[0]) ? args[1] : args[2]),
  },
  and: { arity: [1, Infinity], fn: (args) => args.every(truthy) },
  or: { arity: [1, Infinity], fn: (args) => args.some(truthy) },
  not: { arity: [1, 1], fn: (args) => !truthy(args[0]) },
  empty: { arity: [1, 1], fn: (args) => isEmpty(args[0]) },

  length: {
    arity: [1, 1],
    fn: (args) => {
      const value = args[0]
      if (Array.isArray(value)) return value.length
      return asString(value).length
    },
  },
  concat: { arity: [1, Infinity], fn: (args) => args.map(asString).join('') },
  slice: {
    arity: [2, 3],
    fn: (args, node) => {
      const text = asString(args[0])
      const from = asNumber(args[1], node, 'slice')
      const to = args.length > 2 ? asNumber(args[2], node, 'slice') : undefined
      return text.slice(from, to)
    },
  },
  format: { arity: [1, 1], fn: (args) => asString(args[0]) },
  tonumber: {
    arity: [1, 1],
    fn: (args) => {
      const value = args[0]
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      if (value instanceof Date) return value.getTime()
      const parsed = Number(asString(value).trim())
      return Number.isFinite(parsed) ? parsed : null
    },
  },

  round: { arity: [1, 2], fn: (args, node) => roundTo(args, node, Math.round) },
  floor: { arity: [1, 2], fn: (args, node) => roundTo(args, node, Math.floor) },
  ceil: { arity: [1, 2], fn: (args, node) => roundTo(args, node, Math.ceil) },
  abs: { arity: [1, 1], fn: (args, node) => Math.abs(asNumber(args[0], node, 'abs')) },
  min: { arity: [1, Infinity], fn: (args) => reduceNumbers(args, Math.min) },
  max: { arity: [1, Infinity], fn: (args) => reduceNumbers(args, Math.max) },
  sum: {
    arity: [1, Infinity],
    fn: (args) => flatten(args).reduce<number>((total, v) => total + (looseNumber(v) ?? 0), 0),
  },

  now: { arity: [0, 0], fn: (_args, _node, context) => context.now() },
  dateadd: {
    arity: [3, 3],
    fn: (args, node) => {
      const date = asDate(args[0], node)
      const amount = asNumber(args[1], node, 'dateAdd')
      const unit = asString(args[2]).toLowerCase()
      return addToDate(date, amount, unit, node)
    },
  },
  datebetween: {
    arity: [3, 3],
    fn: (args, node) => {
      const a = asDate(args[0], node)
      const b = asDate(args[1], node)
      const unit = asString(args[2]).toLowerCase()
      const ms = a.getTime() - b.getTime()
      switch (unit) {
        case 'milliseconds': return ms
        case 'seconds': return Math.trunc(ms / 1000)
        case 'minutes': return Math.trunc(ms / 60_000)
        case 'hours': return Math.trunc(ms / 3_600_000)
        case 'days': return Math.trunc(ms / 86_400_000)
        case 'weeks': return Math.trunc(ms / (7 * 86_400_000))
        case 'months': return monthsBetween(a, b)
        case 'years': return Math.trunc(monthsBetween(a, b) / 12)
        default:
          throw new FormulaError(
            `dateBetween does not know the unit "${unit}". Try "days", "weeks", "months" or "years".`,
            node.start, node.end,
          )
      }
    },
  },
  formatdate: {
    arity: [1, 2],
    fn: (args, node) => {
      const date = asDate(args[0], node)
      const pattern = args.length > 1 ? asString(args[1]) : 'D MMM YYYY'
      return formatDatePattern(date, pattern)
    },
  },
}

function evalCall(node: Extract<Node, { type: 'call' }>, context: EvalContext): FormulaValue {
  const entry = FUNCTIONS[node.name]
  if (!entry) {
    throw new FormulaError(`There is no function called "${node.name}".`, node.start, node.end)
  }

  const [minArity, maxArity] = entry.arity
  if (node.args.length < minArity || node.args.length > maxArity) {
    const expected = minArity === maxArity
      ? `${minArity}`
      : maxArity === Infinity ? `at least ${minArity}` : `${minArity} to ${maxArity}`
    throw new FormulaError(
      `${node.name}() takes ${expected} argument${maxArity === 1 ? '' : 's'}, but got ${node.args.length}.`,
      node.start, node.end,
    )
  }

  // `if` must not evaluate the branch it is not taking. Otherwise
  // `if(empty(prop("X")), 0, 100 / prop("X"))` divides by nothing.
  if (node.name === 'if') {
    return truthy(evaluate(node.args[0], context))
      ? evaluate(node.args[1], context)
      : evaluate(node.args[2], context)
  }

  const args = node.args.map((arg) => evaluate(arg, context))
  return entry.fn(args, node, context)
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS)

// --- coercion --------------------------------------------------------------

export function truthy(value: FormulaValue): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function isEmpty(value: FormulaValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'number') return Number.isNaN(value)
  return false
}

export function asString(value: FormulaValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return formatDatePattern(value, 'YYYY-MM-DD')
  return value.map(asString).join(', ')
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  // Trim floating-point noise: 0.1 + 0.2 should read as 0.3 in a table cell.
  return String(Math.round(value * 1e10) / 1e10)
}

function asNumber(value: FormulaValue, node: Node, what: string): number {
  const n = looseNumber(value)
  if (n === null) {
    throw new FormulaError(
      `I cannot ${what} ${describe(value)}. It needs to be a number.`,
      node.start, node.end,
    )
  }
  return n
}

/** Number-ish, without throwing. Used where a missing value should count as 0. */
function looseNumber(value: FormulaValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asDate(value: FormulaValue, node: Node): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms)
  }
  if (typeof value === 'number') return new Date(value)
  throw new FormulaError(
    `I need a date here, but got ${describe(value)}.`,
    node.start, node.end,
  )
}

function comparable(value: FormulaValue, node: Node): number | string {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) && value.trim() !== '' ? n : value
  }
  if (value === null) return 0
  throw new FormulaError(`I cannot compare ${describe(value)}.`, node.start, node.end)
}

function equals(a: FormulaValue, b: FormulaValue): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equals(v, b[i]))
  }
  if (a === null || b === null) return isEmpty(a) && isEmpty(b)
  if (typeof a === typeof b) return a === b
  // Cross-type: compare as text, so prop("Count") == "3" behaves sensibly.
  return asString(a) === asString(b)
}

function describe(value: FormulaValue): string {
  if (value === null || value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  if (value instanceof Date) return 'a date'
  if (typeof value === 'string') return value === '' ? 'empty text' : `the text "${value}"`
  return `${value}`
}

function flatten(values: FormulaValue[]): FormulaValue[] {
  const out: FormulaValue[] = []
  for (const value of values) {
    if (Array.isArray(value)) out.push(...flatten(value))
    else out.push(value)
  }
  return out
}

function roundTo(
  args: FormulaValue[],
  node: Extract<Node, { type: 'call' }>,
  op: (n: number) => number,
): number {
  const value = asNumber(args[0], node, node.name)
  const places = args.length > 1 ? asNumber(args[1], node, node.name) : 0
  const factor = 10 ** places
  return op(value * factor) / factor
}

/**
 * min/max over a flattened argument list, ignoring anything non-numeric.
 *
 * Returns null rather than Infinity for an empty list, because `min()` of
 * nothing is a missing answer and Infinity would propagate silently through
 * every formula downstream of it.
 */
function reduceNumbers(args: FormulaValue[], op: (...n: number[]) => number): number | null {
  const numbers = flatten(args).map(looseNumber).filter((n): n is number => n !== null)
  return numbers.length === 0 ? null : op(...numbers)
}

// --- dates -----------------------------------------------------------------

function addToDate(date: Date, amount: number, unit: string, node: Node): Date {
  const d = new Date(date.getTime())
  switch (unit) {
    case 'milliseconds': d.setMilliseconds(d.getMilliseconds() + amount); break
    case 'seconds': d.setSeconds(d.getSeconds() + amount); break
    case 'minutes': d.setMinutes(d.getMinutes() + amount); break
    case 'hours': d.setHours(d.getHours() + amount); break
    case 'days': d.setDate(d.getDate() + amount); break
    case 'weeks': d.setDate(d.getDate() + amount * 7); break
    // Calendar months, not 30 days. JS does NOT clamp here: setMonth on
    // 31 January produces "31 February", which it silently rolls forward into
    // March. Adding one month to the 31st has to land in February, so the day
    // is clamped to the end of the target month explicitly.
    case 'months': return shiftMonths(d, amount)
    case 'years': return shiftMonths(d, amount * 12)
    default:
      throw new FormulaError(
        `dateAdd does not know the unit "${unit}". Try "days", "weeks", "months" or "years".`,
        node.start, node.end,
      )
  }
  return d
}

/** Add whole months, clamping the day to the end of the target month. */
function shiftMonths(date: Date, months: number): Date {
  const day = date.getDate()
  const target = new Date(date.getTime())
  target.setDate(1)
  target.setMonth(target.getMonth() + months)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDay))
  return target
}

function monthsBetween(a: Date, b: Date): number {
  const months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth())
  // Do not count a month that has not completed: 31 Jan to 1 Feb is zero.
  return a.getDate() < b.getDate() ? months - (months > 0 ? 1 : 0) : months
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Pattern-based date formatting.
 *
 * Hand-rolled rather than Intl, because the point of `formatDate` is that the
 * *user* chooses the shape, and Intl only offers named styles. Longest tokens
 * first so YYYY is not eaten by YY.
 */
export function formatDatePattern(date: Date, pattern: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const replacements: Array<[string, string]> = [
    ['YYYY', String(date.getFullYear())],
    ['YY', pad(date.getFullYear() % 100)],
    ['MMMM', fullMonth(date.getMonth())],
    ['MMM', MONTHS[date.getMonth()]],
    ['MM', pad(date.getMonth() + 1)],
    ['DDDD', fullDay(date.getDay())],
    ['DDD', DAYS[date.getDay()]],
    ['DD', pad(date.getDate())],
    ['D', String(date.getDate())],
    ['HH', pad(date.getHours())],
    ['mm', pad(date.getMinutes())],
    ['ss', pad(date.getSeconds())],
    ['M', String(date.getMonth() + 1)],
  ]

  let out = ''
  let i = 0
  outer: while (i < pattern.length) {
    for (const [token, value] of replacements) {
      if (pattern.startsWith(token, i)) {
        out += value
        i += token.length
        continue outer
      }
    }
    out += pattern[i]
    i++
  }
  return out
}

function fullMonth(index: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][index]
}

function fullDay(index: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index]
}
