/**
 * The formula language: lexer and recursive-descent parser.
 *
 * Hand-written rather than generated, because the error messages are half the
 * product. A parser generator would give a correct grammar and then say
 * "unexpected token at position 14", which tells a person nothing about the
 * formula they just typed. Every failure here carries a span so the editor can
 * underline the offending characters and say what it expected instead.
 *
 * Precedence, loosest to tightest:
 *   or -> and -> not -> comparison -> additive -> multiplicative -> unary -> primary
 *
 * Standard climbing, one function per level. The shape is verbose and it is
 * also the thing that makes the grammar readable at a glance, which matters
 * more than concision in code nobody touches for months at a time.
 */

export type TokenKind =
  | 'number' | 'string' | 'identifier'
  | 'operator' | 'punct' | 'end'

export interface Token {
  kind: TokenKind
  value: string
  start: number
  end: number
}

export class FormulaError extends Error {
  constructor(message: string, readonly start: number, readonly end: number) {
    super(message)
    this.name = 'FormulaError'
  }
}

const OPERATORS = [
  '>=', '<=', '==', '!=', '=',
  '+', '-', '*', '/', '%', '<', '>',
]

const WORD_OPERATORS = new Set(['and', 'or', 'not'])
const LITERALS = new Set(['true', 'false'])

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < source.length) {
    const char = source[i]

    if (/\s/.test(char)) { i++; continue }

    if (char === '"' || char === "'") {
      const quote = char
      const start = i
      i++
      let value = ''
      while (i < source.length && source[i] !== quote) {
        // Escapes are supported so a formula can contain a quote at all.
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        value += source[i]
        i++
      }
      if (i >= source.length) {
        throw new FormulaError('This text is missing a closing quote.', start, source.length)
      }
      i++
      tokens.push({ kind: 'string', value, start, end: i })
      continue
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i
      while (i < source.length && /[0-9._]/.test(source[i])) i++
      const raw = source.slice(start, i).replace(/_/g, '')
      if (!/^\d*\.?\d+$/.test(raw) && !/^\d+\.$/.test(raw)) {
        throw new FormulaError(`"${raw}" is not a number I can read.`, start, i)
      }
      tokens.push({ kind: 'number', value: raw, start, end: i })
      continue
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = i
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++
      const value = source.slice(start, i)
      tokens.push({
        kind: WORD_OPERATORS.has(value.toLowerCase()) ? 'operator' : 'identifier',
        value,
        start,
        end: i,
      })
      continue
    }

    if ('(),'.includes(char)) {
      tokens.push({ kind: 'punct', value: char, start: i, end: i + 1 })
      i++
      continue
    }

    const operator = OPERATORS.find((op) => source.startsWith(op, i))
    if (operator) {
      // A single `=` is almost always a typo for `==`, and silently accepting
      // it as equality would hide the mistake in every other language.
      tokens.push({ kind: 'operator', value: operator === '=' ? '==' : operator, start: i, end: i + operator.length })
      i += operator.length
      continue
    }

    throw new FormulaError(`I do not know what to do with "${char}".`, i, i + 1)
  }

  tokens.push({ kind: 'end', value: '', start: i, end: i })
  return tokens
}

// --- AST -------------------------------------------------------------------

export type Node =
  | { type: 'number'; value: number; start: number; end: number }
  | { type: 'string'; value: string; start: number; end: number }
  | { type: 'boolean'; value: boolean; start: number; end: number }
  | { type: 'prop'; name: string; start: number; end: number }
  | { type: 'call'; name: string; args: Node[]; start: number; end: number }
  | { type: 'unary'; op: string; operand: Node; start: number; end: number }
  | { type: 'binary'; op: string; left: Node; right: Node; start: number; end: number }

export function parse(source: string): Node {
  const tokens = tokenize(source)
  let position = 0

  const peek = () => tokens[position]
  const next = () => tokens[position++]

  const expect = (value: string, what: string): Token => {
    const token = peek()
    if (token.value !== value) {
      throw new FormulaError(
        `Expected ${what} here${token.kind === 'end' ? ', but the formula ended' : `, but found "${token.value}"`}.`,
        token.start,
        token.end,
      )
    }
    return next()
  }

  const eat = (value: string): boolean => {
    if (peek().value.toLowerCase() === value) { next(); return true }
    return false
  }

  function parseExpression(): Node {
    return parseOr()
  }

  function parseOr(): Node {
    let left = parseAnd()
    while (peek().kind === 'operator' && peek().value.toLowerCase() === 'or') {
      next()
      const right = parseAnd()
      left = { type: 'binary', op: 'or', left, right, start: left.start, end: right.end }
    }
    return left
  }

  function parseAnd(): Node {
    let left = parseNot()
    while (peek().kind === 'operator' && peek().value.toLowerCase() === 'and') {
      next()
      const right = parseNot()
      left = { type: 'binary', op: 'and', left, right, start: left.start, end: right.end }
    }
    return left
  }

  function parseNot(): Node {
    if (peek().kind === 'operator' && peek().value.toLowerCase() === 'not') {
      const token = next()
      const operand = parseNot()
      return { type: 'unary', op: 'not', operand, start: token.start, end: operand.end }
    }
    return parseComparison()
  }

  function parseComparison(): Node {
    let left = parseAdditive()
    while (peek().kind === 'operator' && ['==', '!=', '<', '>', '<=', '>='].includes(peek().value)) {
      const op = next().value
      const right = parseAdditive()
      left = { type: 'binary', op, left, right, start: left.start, end: right.end }
    }
    return left
  }

  function parseAdditive(): Node {
    let left = parseMultiplicative()
    while (peek().kind === 'operator' && ['+', '-'].includes(peek().value)) {
      const op = next().value
      const right = parseMultiplicative()
      left = { type: 'binary', op, left, right, start: left.start, end: right.end }
    }
    return left
  }

  function parseMultiplicative(): Node {
    let left = parseUnary()
    while (peek().kind === 'operator' && ['*', '/', '%'].includes(peek().value)) {
      const op = next().value
      const right = parseUnary()
      left = { type: 'binary', op, left, right, start: left.start, end: right.end }
    }
    return left
  }

  function parseUnary(): Node {
    if (peek().kind === 'operator' && peek().value === '-') {
      const token = next()
      const operand = parseUnary()
      return { type: 'unary', op: '-', operand, start: token.start, end: operand.end }
    }
    return parsePrimary()
  }

  function parsePrimary(): Node {
    const token = peek()

    if (token.kind === 'number') {
      next()
      return { type: 'number', value: Number(token.value), start: token.start, end: token.end }
    }

    if (token.kind === 'string') {
      next()
      return { type: 'string', value: token.value, start: token.start, end: token.end }
    }

    if (token.value === '(') {
      next()
      const inner = parseExpression()
      expect(')', 'a closing bracket')
      return inner
    }

    if (token.kind === 'identifier') {
      const lower = token.value.toLowerCase()

      if (LITERALS.has(lower)) {
        next()
        return { type: 'boolean', value: lower === 'true', start: token.start, end: token.end }
      }

      next()

      if (peek().value === '(') {
        next()
        const args: Node[] = []
        if (peek().value !== ')') {
          do { args.push(parseExpression()) } while (eat(','))
        }
        const close = expect(')', 'a closing bracket')

        // prop("Name") is the one call whose argument must be a literal: it
        // names a column, and a computed column name would make the dependency
        // graph undecidable - which is the thing that makes cycle detection
        // possible at all.
        if (lower === 'prop') {
          const arg = args[0]
          if (args.length !== 1 || !arg || arg.type !== 'string') {
            throw new FormulaError(
              'prop() needs the name of a property in quotes, like prop("Status").',
              token.start,
              close.end,
            )
          }
          return { type: 'prop', name: arg.value, start: token.start, end: close.end }
        }

        return { type: 'call', name: lower, args, start: token.start, end: close.end }
      }

      // A bare identifier is almost always a property someone forgot to wrap.
      throw new FormulaError(
        `"${token.value}" is not a function. To use a property, write prop("${token.value}").`,
        token.start,
        token.end,
      )
    }

    if (token.kind === 'end') {
      throw new FormulaError('The formula ended before it was finished.', token.start, token.end)
    }

    throw new FormulaError(`I did not expect "${token.value}" here.`, token.start, token.end)
  }

  const result = parseExpression()
  const trailing = peek()
  if (trailing.kind !== 'end') {
    throw new FormulaError(
      `Unexpected "${trailing.value}" after the end of the formula.`,
      trailing.start,
      trailing.end,
    )
  }
  return result
}

/** Every property name a formula reads. Used to build the dependency graph. */
export function referencedProperties(node: Node): string[] {
  const names = new Set<string>()
  const walk = (n: Node) => {
    switch (n.type) {
      case 'prop': names.add(n.name); break
      case 'call': n.args.forEach(walk); break
      case 'unary': walk(n.operand); break
      case 'binary': walk(n.left); walk(n.right); break
      default: break
    }
  }
  walk(node)
  return [...names]
}
