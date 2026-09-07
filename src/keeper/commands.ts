import type { WorkspaceState } from '@/state/types'
import type { Page } from '@/state/blocks'
import type { Command } from '@/state/commands'
import { SetPropertyValue } from '@/state/databaseCommands'
import { inferMapping } from '@/island/derive'
import type { DateValue } from '@/state/database'

/**
 * Turning the Keeper's intents into commands.
 *
 * This is the join Section 2 insists on: tending a plant and ticking the same
 * task's checkbox in a table produce *the same* `SetPropertyValue`. There is no
 * island-specific mutation path, which is why undo, persistence and the derived
 * island all behave identically no matter which half of the product you touched.
 *
 * Kept out of `system.ts` on purpose - the Keeper stack knows nothing about the
 * store, and this module is the only place that knows both.
 */

/** The page's database, or null for a loose page that belongs to none. */
function databaseOf(state: WorkspaceState, page: Page) {
  return page.databaseId ? state.databases[page.databaseId] ?? null : null
}

/**
 * Mark a task complete.
 *
 * Returns null when there is nothing sensible to set - a page with no database,
 * or a database with no status or checkbox property. Silently doing nothing is
 * correct here: the plant is still a plant, and the alternative is inventing a
 * property on the user's database because they walked near it.
 */
export function tendCommand(state: WorkspaceState, pageId: string): Command | null {
  const page = state.pages[pageId]
  if (!page) return null

  const database = databaseOf(state, page)
  if (!database) return null

  const { statusProperty } = inferMapping(database)
  if (!statusProperty) return null

  const property = database.properties.find((p) => p.id === statusProperty)
  if (!property) return null

  if (property.type === 'checkbox') {
    return new SetPropertyValue(pageId, statusProperty, true, 'Tend a plant')
  }

  // Status: pick the user's own "complete" option rather than a name we
  // invented. A Placement Prep board might call it "Offer" and a DSA tracker
  // "Mastered"; the island understands the group, not the label.
  const complete = property.options?.find((o) => o.group === 'complete')
  if (!complete) return null

  return new SetPropertyValue(pageId, statusProperty, complete.id, 'Tend a plant')
}

/**
 * Move a task's due date, because its plant was set down at that elevation.
 *
 * Stored as a plain ISO date with no time, matching what the date picker writes
 * - a plant put down on a hillside means "this day", not "this day at 14:32".
 */
export function rescheduleCommand(
  state: WorkspaceState,
  pageId: string,
  dueMillis: number,
): Command | null {
  const page = state.pages[pageId]
  if (!page) return null

  const database = databaseOf(state, page)
  if (!database) return null

  const { dueProperty } = inferMapping(database)
  if (!dueProperty) return null

  const value: DateValue = { start: isoDate(dueMillis) }
  return new SetPropertyValue(pageId, dueProperty, value, 'Replant')
}

/**
 * Local ISO date, `YYYY-MM-DD`.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which converts to UTC first
 * and therefore reports yesterday for anyone east of Greenwich in the evening -
 * the sort of bug that only appears for users in one half of the world.
 */
function isoDate(millis: number): string {
  const d = new Date(millis)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}
