import { describe, it, expect } from 'vitest'
import { parseStoredDate, dateToMillis, readDate } from './database'

/**
 * A bare date is a calendar day, anchored where the person who typed it lives.
 *
 * `Date.parse('2026-06-14')` is UTC midnight. Formatted in a local zone west
 * of Greenwich that is the evening of June 13 - so a task due Friday showed as
 * due Thursday across the whole of the Americas. The date picker writes local
 * calendar days; reading them back has to use the same anchor.
 */
describe('parseStoredDate', () => {
  it('anchors a bare date at local midnight', () => {
    expect(parseStoredDate('2026-06-14')).toBe(new Date(2026, 5, 14).getTime())
  })

  it('round-trips through the local calendar', () => {
    const ms = parseStoredDate('2026-01-05')
    const d = new Date(ms)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 1, 5])
    expect(d.getHours()).toBe(0)
  })

  it('leaves a datetime with its own offset alone', () => {
    const iso = '2026-06-14T09:30:00.000Z'
    expect(parseStoredDate(iso)).toBe(Date.parse(iso))
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseStoredDate(' 2026-06-14 ')).toBe(new Date(2026, 5, 14).getTime())
  })

  it('returns NaN for garbage, so callers can refuse it', () => {
    expect(Number.isNaN(parseStoredDate('not a date'))).toBe(true)
  })
})

describe('dateToMillis', () => {
  it('uses the local anchor for stored date values', () => {
    expect(dateToMillis({ start: '2026-06-14' })).toBe(new Date(2026, 5, 14).getTime())
    expect(dateToMillis('2026-06-14')).toBe(new Date(2026, 5, 14).getTime())
  })

  it('returns null for empty and invalid values', () => {
    expect(dateToMillis(null)).toBeNull()
    expect(dateToMillis('')).toBeNull()
    expect(dateToMillis({ start: 'nonsense' })).toBeNull()
  })

  it('agrees with readDate about what counts as a date', () => {
    expect(readDate({ start: '2026-06-14' })).toEqual({ start: '2026-06-14' })
    expect(readDate('')).toBeNull()
  })
})
