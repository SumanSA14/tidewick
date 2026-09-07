/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest'
import {
  marksToHtml, readInline, normaliseMarks, hasMark, toggleMark, removeMark,
  shiftMarks, escapeHtml,
} from './inline'
import type { Mark } from '@/state/blocks'

const bold = (start: number, end: number): Mark => ({ start, end, type: 'bold' })
const italic = (start: number, end: number): Mark => ({ start, end, type: 'italic' })

describe('escaping', () => {
  it('escapes the characters that would otherwise become markup', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })

  it('escapes text inside marks too', () => {
    // A block containing "<script>" must never reach innerHTML unescaped.
    const html = marksToHtml('<script>', [bold(0, 8)])
    expect(html).toBe('<strong>&lt;script&gt;</strong>')
  })
})

describe('marksToHtml', () => {
  it('renders plain text with no wrapper', () => {
    expect(marksToHtml('hello', [])).toBe('hello')
  })

  it('wraps a single mark', () => {
    expect(marksToHtml('hello', [bold(0, 5)])).toBe('<strong>hello</strong>')
  })

  it('splits a run where a mark starts and ends', () => {
    expect(marksToHtml('hello world', [bold(0, 5)])).toBe('<strong>hello</strong> world')
  })

  it('handles overlapping marks without nesting one inside the other', () => {
    // A tree model forces bold to be the parent of italic or vice versa, and
    // then "extend the bold by a word" becomes a restructuring problem. Ranges
    // just overlap, and the renderer emits a run per distinct mark set.
    const html = marksToHtml('abcdef', [bold(0, 4), italic(2, 6)])
    expect(html).toContain('<strong>ab</strong>')
    expect(html).toContain('ef')
    // The overlapping middle carries both.
    expect(html).toMatch(/<strong><em>cd<\/em><\/strong>|<em><strong>cd<\/strong><\/em>/)
  })

  it('renders a link with a safe rel', () => {
    const html = marksToHtml('click', [{ start: 0, end: 5, type: 'link', href: 'https://example.com' }])
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('escapes a hostile href', () => {
    const html = marksToHtml('x', [{ start: 0, end: 1, type: 'link', href: '"><img>' }])
    expect(html).not.toContain('<img>')
  })

  it('returns empty string for empty text', () => {
    expect(marksToHtml('', [bold(0, 5)])).toBe('')
  })

  it('ignores marks that point past the end of the text', () => {
    expect(marksToHtml('ab', [bold(5, 9)])).toBe('ab')
  })
})

describe('normaliseMarks', () => {
  it('drops empty and inverted ranges', () => {
    expect(normaliseMarks([bold(3, 3), bold(5, 2)], 10)).toEqual([])
  })

  it('clips to the text length', () => {
    expect(normaliseMarks([bold(0, 99)], 4)).toEqual([bold(0, 4)])
  })

  it('merges adjacent runs of the same mark', () => {
    // Without this, typing across a bold boundary accumulates dozens of
    // one-character ranges that render identically and grow the state forever.
    expect(normaliseMarks([bold(0, 2), bold(2, 5)], 5)).toEqual([bold(0, 5)])
  })

  it('merges overlapping runs of the same mark', () => {
    expect(normaliseMarks([bold(0, 4), bold(2, 7)], 10)).toEqual([bold(0, 7)])
  })

  it('keeps different mark types apart', () => {
    const out = normaliseMarks([bold(0, 3), italic(0, 3)], 5)
    expect(out).toHaveLength(2)
  })

  it('keeps links with different hrefs apart', () => {
    const out = normaliseMarks([
      { start: 0, end: 2, type: 'link', href: 'a' },
      { start: 2, end: 4, type: 'link', href: 'b' },
    ], 4)
    expect(out).toHaveLength(2)
  })
})

describe('hasMark', () => {
  it('is true only when every character is covered', () => {
    expect(hasMark([bold(0, 5)], 1, 4, 'bold')).toBe(true)
    expect(hasMark([bold(0, 3)], 1, 5, 'bold')).toBe(false)
  })

  it('is true across two ranges that jointly cover the span', () => {
    expect(hasMark([bold(0, 3), bold(3, 6)], 1, 5, 'bold')).toBe(true)
  })

  it('is false for an empty range', () => {
    expect(hasMark([bold(0, 5)], 2, 2, 'bold')).toBe(false)
  })
})

describe('toggleMark', () => {
  it('adds when not fully covered', () => {
    expect(toggleMark([], 5, 0, 5, 'bold')).toEqual([bold(0, 5)])
  })

  it('removes when fully covered', () => {
    expect(toggleMark([bold(0, 5)], 5, 0, 5, 'bold')).toEqual([])
  })

  it('adds over a partially covered range rather than removing', () => {
    const out = toggleMark([bold(0, 2)], 6, 0, 6, 'bold')
    expect(out).toEqual([bold(0, 6)])
  })

  it('is a no-op for a collapsed selection', () => {
    const marks = [bold(0, 3)]
    expect(toggleMark(marks, 5, 2, 2, 'bold')).toBe(marks)
  })
})

describe('removeMark', () => {
  it('splits a mark that straddles the removed range', () => {
    expect(removeMark([bold(0, 10)], 10, 4, 6, 'bold')).toEqual([bold(0, 4), bold(6, 10)])
  })

  it('trims from the start and the end', () => {
    expect(removeMark([bold(2, 8)], 10, 0, 4, 'bold')).toEqual([bold(4, 8)])
    expect(removeMark([bold(2, 8)], 10, 6, 10, 'bold')).toEqual([bold(2, 6)])
  })

  it('leaves other mark types untouched', () => {
    const out = removeMark([bold(0, 5), italic(0, 5)], 5, 0, 5, 'bold')
    expect(out).toEqual([italic(0, 5)])
  })
})

describe('shiftMarks', () => {
  it('moves marks after an insertion', () => {
    expect(shiftMarks([bold(5, 8)], 2, 2, 3)).toEqual([bold(8, 11)])
  })

  it('moves marks after a deletion', () => {
    expect(shiftMarks([bold(5, 8)], 0, 3, 0)).toEqual([bold(2, 5)])
  })

  it('leaves marks before the edit alone', () => {
    expect(shiftMarks([bold(0, 2)], 5, 5, 4)).toEqual([bold(0, 2)])
  })

  it('drops a mark whose whole range was deleted', () => {
    expect(shiftMarks([bold(3, 6)], 2, 8, 0)).toEqual([])
  })
})

describe('readInline', () => {
  const parse = (html: string) => {
    const el = document.createElement('div')
    el.innerHTML = html
    return readInline(el)
  }

  it('reads plain text', () => {
    expect(parse('hello')).toEqual({ text: 'hello', marks: [] })
  })

  it('reads a mark back out', () => {
    expect(parse('<strong>hi</strong> there')).toEqual({
      text: 'hi there',
      marks: [bold(0, 2)],
    })
  })

  it('accepts the tags a browser emits for its own bold and italic', () => {
    // The native Cmd+B inserts <b>, not <strong>. Autocorrect and paste produce
    // their own variety. The store has to end up with our representation
    // regardless of what the DOM decided to become.
    expect(parse('<b>a</b>').marks).toEqual([bold(0, 1)])
    expect(parse('<i>a</i>').marks).toEqual([italic(0, 1)])
    expect(parse('<del>a</del>').marks).toEqual([{ start: 0, end: 1, type: 'strike' }])
  })

  it('reads nested marks as two overlapping ranges', () => {
    const { text, marks } = parse('<strong><em>both</em></strong>')
    expect(text).toBe('both')
    expect(marks).toHaveLength(2)
    expect(marks.every((m) => m.start === 0 && m.end === 4)).toBe(true)
  })

  it('captures a link href', () => {
    const { marks } = parse('<a href="https://example.com">x</a>')
    expect(marks[0]).toMatchObject({ type: 'link', href: 'https://example.com' })
  })

  it('ignores unknown wrapper elements but keeps their text', () => {
    expect(parse('<span style="color:red">plain</span>')).toEqual({ text: 'plain', marks: [] })
  })

  it('drops a mark that wraps nothing', () => {
    expect(parse('<strong></strong>text').marks).toEqual([])
  })

  it('round-trips text and marks through HTML unchanged', () => {
    const text = 'the quick brown fox'
    const marks = normaliseMarks([bold(4, 9), italic(10, 15)], text.length)
    const back = parse(marksToHtml(text, marks))
    expect(back.text).toBe(text)
    expect(back.marks).toEqual(marks)
  })
})
