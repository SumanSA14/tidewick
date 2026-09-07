import type { Command } from './commands'
import type { WorkspaceState } from './types'
import { newId } from './blockCommands'
import { readStringArray, type PropertyDef } from './database'

/**
 * Bidirectional relations.
 *
 * Section 6.4: creating a relation auto-creates the inverse on the target
 * database, and deleting cleans up both sides. That symmetry is not a
 * convenience - it is what makes rollups and, in Phase 4 onward, footpaths
 * between regions possible at all. A one-way link means "which applications
 * reference this contact" can only be answered by scanning every row.
 *
 * The hard part is not creating the pair, it is *maintaining* it: every write
 * to one side has to add and remove exactly the right entries on the other,
 * and it has to invert cleanly. That is why relation edits get their own
 * command rather than going through SetPropertyValue.
 */

export class AddRelation implements Command {
  readonly propertyId: string
  readonly inverseId: string

  constructor(
    private readonly databaseId: string,
    private readonly targetDatabaseId: string,
    private readonly name: string,
    private readonly inverseName: string,
    propertyId = newId(),
    inverseId = newId(),
  ) {
    this.propertyId = propertyId
    this.inverseId = inverseId
  }

  get label(): string { return `Add ${this.name}` }

  apply(draft: WorkspaceState): void {
    const source = draft.databases[this.databaseId]
    const target = draft.databases[this.targetDatabaseId]
    if (!source || !target) return

    const forward: PropertyDef = {
      id: this.propertyId,
      name: this.name,
      type: 'relation',
      relationDatabaseId: this.targetDatabaseId,
      inversePropertyId: this.inverseId,
    }
    const backward: PropertyDef = {
      id: this.inverseId,
      name: this.inverseName,
      type: 'relation',
      relationDatabaseId: this.databaseId,
      inversePropertyId: this.propertyId,
    }

    source.properties.push(forward)
    for (const view of source.views) view.visibleProperties.push(this.propertyId)

    // A self-relation needs only one property: adding the inverse to the same
    // database would give it two columns that mirror each other forever.
    if (this.targetDatabaseId !== this.databaseId) {
      target.properties.push(backward)
      for (const view of target.views) view.visibleProperties.push(this.inverseId)
    }
  }

  invert(draft: WorkspaceState): void {
    const source = draft.databases[this.databaseId]
    const target = draft.databases[this.targetDatabaseId]

    if (source) {
      source.properties = source.properties.filter((p) => p.id !== this.propertyId)
      for (const view of source.views) {
        view.visibleProperties = view.visibleProperties.filter((id) => id !== this.propertyId)
      }
      for (const rowId of source.rows) {
        const page = draft.pages[rowId]
        if (page?.properties) delete page.properties[this.propertyId]
      }
    }

    if (target && this.targetDatabaseId !== this.databaseId) {
      target.properties = target.properties.filter((p) => p.id !== this.inverseId)
      for (const view of target.views) {
        view.visibleProperties = view.visibleProperties.filter((id) => id !== this.inverseId)
      }
      for (const rowId of target.rows) {
        const page = draft.pages[rowId]
        if (page?.properties) delete page.properties[this.inverseId]
      }
    }
  }
}

/**
 * Set one side of a relation, maintaining the other.
 *
 * Snapshots every list it touches rather than trying to recompute the inverse
 * on undo. Recomputing looks tidier and is wrong: if the same edit both added
 * and removed links, the reverse operation is not derivable from the new value
 * alone, and undo would leave dangling references on the far side.
 */
export class SetRelation implements Command {
  readonly label = 'Link'
  private before: string[] = []
  private inverseBefore = new Map<string, string[]>()
  private captured = false

  constructor(
    private readonly rowId: string,
    private readonly propertyId: string,
    private readonly value: string[],
  ) {}

  apply(draft: WorkspaceState): void {
    const page = draft.pages[this.rowId]
    if (!page) return
    if (!page.properties) page.properties = {}

    const database = page.databaseId ? draft.databases[page.databaseId] : undefined
    const property = database?.properties.find((p) => p.id === this.propertyId)
    const inverseId = property?.inversePropertyId

    if (!this.captured) {
      this.before = readStringArray(page.properties[this.propertyId])
      if (inverseId) {
        // Snapshot both the pages losing a link and the ones gaining one.
        const touched = new Set([...this.before, ...this.value])
        for (const id of touched) {
          const other = draft.pages[id]
          if (other) this.inverseBefore.set(id, readStringArray(other.properties?.[inverseId]))
        }
      }
      this.captured = true
    }

    page.properties[this.propertyId] = [...this.value]
    page.updatedAt = Date.now()

    if (!inverseId) return

    const added = this.value.filter((id) => !this.before.includes(id))
    const removed = this.before.filter((id) => !this.value.includes(id))

    for (const id of added) {
      const other = draft.pages[id]
      if (!other) continue
      if (!other.properties) other.properties = {}
      const current = readStringArray(other.properties[inverseId])
      if (!current.includes(this.rowId)) other.properties[inverseId] = [...current, this.rowId]
    }

    for (const id of removed) {
      const other = draft.pages[id]
      if (!other?.properties) continue
      other.properties[inverseId] = readStringArray(other.properties[inverseId])
        .filter((linked) => linked !== this.rowId)
    }
  }

  invert(draft: WorkspaceState): void {
    if (!this.captured) return
    const page = draft.pages[this.rowId]
    if (!page) return
    if (!page.properties) page.properties = {}
    page.properties[this.propertyId] = [...this.before]

    const database = page.databaseId ? draft.databases[page.databaseId] : undefined
    const inverseId = database?.properties.find((p) => p.id === this.propertyId)?.inversePropertyId
    if (!inverseId) return

    for (const [id, list] of this.inverseBefore) {
      const other = draft.pages[id]
      if (!other) continue
      if (!other.properties) other.properties = {}
      other.properties[inverseId] = [...list]
    }
  }
}

/**
 * Every link, as pairs of page ids.
 *
 * Deduplicated across both sides of a relation - a link stored on A pointing at
 * B and mirrored on B pointing at A is *one* footpath on the island, not two.
 */
export function collectLinks(state: WorkspaceState): Array<[string, string]> {
  const seen = new Set<string>()
  const links: Array<[string, string]> = []

  for (const database of Object.values(state.databases)) {
    const relations = database.properties.filter((p) => p.type === 'relation')
    if (relations.length === 0) continue

    for (const rowId of database.rows) {
      const page = state.pages[rowId]
      if (!page || page.trashed) continue
      for (const relation of relations) {
        for (const targetId of readStringArray(page.properties?.[relation.id])) {
          const target = state.pages[targetId]
          if (!target || target.trashed) continue
          // Order-independent key, so the mirrored copy is not counted twice.
          const key = rowId < targetId ? `${rowId}|${targetId}` : `${targetId}|${rowId}`
          if (seen.has(key)) continue
          seen.add(key)
          links.push([rowId, targetId])
        }
      }
    }
  }

  return links
}
