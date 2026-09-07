import type { Command } from './commands'
import type { WorkspaceState } from './types'
import { createPage, createBlock } from './blocks'
import { newId } from './blockCommands'
import {
  createDatabase, createView, findProperty, clonePropertyValue, DEFAULT_STATUS_OPTIONS,
  type Database, type FilterGroup, type FilterNode, type PropertyDef,
  type PropertyType, type PropertyValue, type SelectOption, type SortRule,
  type View, type ViewKind,
} from './database'

/**
 * Database commands.
 *
 * The same rule as everywhere else: one mutation path, everything invertible.
 * Schema edits are the sharpest case - deleting a property has to remember not
 * just the definition but every value in every row, because restoring the
 * column without its contents is a data loss dressed up as an undo.
 */

function cloneProperty(p: PropertyDef): PropertyDef {
  return { ...p, options: p.options ? p.options.map((o) => ({ ...o })) : undefined }
}

function cloneFilter(node: FilterNode): FilterNode {
  return node.kind === 'group'
    ? { ...node, children: node.children.map(cloneFilter) }
    : { ...node }
}

function cloneView(v: View): View {
  return {
    ...v,
    filter: cloneFilter(v.filter) as FilterGroup,
    sorts: v.sorts.map((s) => ({ ...s })),
    visibleProperties: [...v.visibleProperties],
    columnWidths: v.columnWidths ? { ...v.columnWidths } : undefined,
    collapsedGroups: v.collapsedGroups ? [...v.collapsedGroups] : undefined,
  }
}

/** Locate a view inside a database by id. */
function viewIn(database: Database | undefined, viewId: string): View | undefined {
  return database?.views.find((v) => v.id === viewId)
}

// --- databases -------------------------------------------------------------

export class CreateDatabase implements Command {
  readonly label = 'New database'
  readonly databaseId: string
  readonly titlePropertyId: string
  readonly viewId: string

  constructor(
    private readonly name: string,
    databaseId = newId(),
    titlePropertyId = newId(),
    viewId = newId(),
  ) {
    this.databaseId = databaseId
    this.titlePropertyId = titlePropertyId
    this.viewId = viewId
  }

  apply(draft: WorkspaceState): void {
    draft.databases[this.databaseId] = createDatabase(
      this.databaseId, this.name, this.titlePropertyId, this.viewId,
    )
  }

  invert(draft: WorkspaceState): void {
    delete draft.databases[this.databaseId]
  }
}

export class RenameDatabase implements Command {
  readonly label = 'Rename database'
  private before = ''
  private captured = false

  constructor(private readonly databaseId: string, private readonly name: string) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    if (!this.captured) { this.before = db.name; this.captured = true }
    db.name = this.name
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (db && this.captured) db.name = this.before
  }
}

// --- schema ----------------------------------------------------------------

export class AddProperty implements Command {
  readonly propertyId: string

  constructor(
    private readonly databaseId: string,
    private readonly type: PropertyType,
    private readonly name: string,
    propertyId = newId(),
    private readonly extras: Partial<PropertyDef> = {},
  ) {
    this.propertyId = propertyId
  }

  get label(): string { return `Add ${this.name}` }

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const property: PropertyDef = { id: this.propertyId, name: this.name, type: this.type, ...this.extras }
    // A status property is useless without its three groups, and asking the
    // user to invent them is asking them to do the engine's job.
    if (this.type === 'status' && !property.options) {
      property.options = DEFAULT_STATUS_OPTIONS.map((o) => ({ ...o, id: newId() }))
    }
    if ((this.type === 'select' || this.type === 'multiSelect') && !property.options) {
      property.options = []
    }
    if (this.type === 'number' && !property.numberFormat) property.numberFormat = 'plain'
    db.properties.push(property)
    // New columns appear in every view; hiding them by default means adding a
    // property looks like it silently failed.
    for (const view of db.views) view.visibleProperties.push(this.propertyId)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    db.properties = db.properties.filter((p) => p.id !== this.propertyId)
    for (const view of db.views) {
      view.visibleProperties = view.visibleProperties.filter((id) => id !== this.propertyId)
    }
  }
}

/**
 * Delete a property, including every value stored under it.
 *
 * The values have to be snapshotted. Restoring an empty column would be an
 * undo that loses data while appearing to succeed, which is the worst kind.
 */
export class DeleteProperty implements Command {
  readonly label = 'Delete property'
  private property: PropertyDef | null = null
  private index = -1
  private values = new Map<string, PropertyValue>()
  private viewVisibility = new Map<string, number>()
  private captured = false

  constructor(private readonly databaseId: string, private readonly propertyId: string) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const index = db.properties.findIndex((p) => p.id === this.propertyId)
    if (index === -1) return
    // Refuse to remove the title: a row with no display name is unreachable
    // in every view at once.
    if (db.properties[index].type === 'title') return

    if (!this.captured) {
      this.index = index
      this.property = cloneProperty(db.properties[index])
      for (const rowId of db.rows) {
        const value = draft.pages[rowId]?.properties?.[this.propertyId]
        if (value !== undefined) this.values.set(rowId, value)
      }
      for (const view of db.views) {
        const at = view.visibleProperties.indexOf(this.propertyId)
        if (at !== -1) this.viewVisibility.set(view.id, at)
      }
      this.captured = true
    }

    db.properties.splice(index, 1)
    for (const view of db.views) {
      view.visibleProperties = view.visibleProperties.filter((id) => id !== this.propertyId)
      view.sorts = view.sorts.filter((s) => s.propertyId !== this.propertyId)
      if (view.groupBy === this.propertyId) view.groupBy = undefined
      view.filter = pruneFilter(view.filter, this.propertyId)
    }
    for (const rowId of db.rows) {
      const page = draft.pages[rowId]
      if (page?.properties) delete page.properties[this.propertyId]
    }
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db || !this.captured || !this.property) return
    db.properties.splice(this.index, 0, cloneProperty(this.property))
    for (const view of db.views) {
      const at = this.viewVisibility.get(view.id)
      if (at !== undefined) view.visibleProperties.splice(at, 0, this.propertyId)
    }
    for (const [rowId, value] of this.values) {
      const page = draft.pages[rowId]
      if (!page) continue
      if (!page.properties) page.properties = {}
      page.properties[this.propertyId] = value
    }
  }
}

/** Drop any filter rule referencing a removed property. */
function pruneFilter(group: FilterGroup, propertyId: string): FilterGroup {
  return {
    ...group,
    children: group.children
      .filter((child) => child.kind === 'group' || child.propertyId !== propertyId)
      .map((child) => (child.kind === 'group' ? pruneFilter(child, propertyId) : child)),
  }
}

export class UpdateProperty implements Command {
  readonly label = 'Edit property'
  private before: PropertyDef | null = null
  private captured = false

  constructor(
    private readonly databaseId: string,
    private readonly propertyId: string,
    private readonly patch: Partial<PropertyDef>,
  ) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const property = db && findProperty(db, this.propertyId)
    if (!property) return
    if (!this.captured) { this.before = cloneProperty(property); this.captured = true }
    Object.assign(property, this.patch)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const index = db?.properties.findIndex((p) => p.id === this.propertyId) ?? -1
    if (!db || index === -1 || !this.before) return
    db.properties[index] = cloneProperty(this.before)
  }
}

export class ReorderProperty implements Command {
  readonly label = 'Reorder property'
  private from = -1
  private moved = false

  constructor(
    private readonly databaseId: string,
    private readonly propertyId: string,
    private readonly toIndex: number,
  ) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const from = db.properties.findIndex((p) => p.id === this.propertyId)
    if (from === -1) return
    this.from = from
    this.moved = true
    const [property] = db.properties.splice(from, 1)
    db.properties.splice(Math.max(0, Math.min(this.toIndex, db.properties.length)), 0, property)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db || !this.moved) return
    const at = db.properties.findIndex((p) => p.id === this.propertyId)
    if (at === -1) return
    const [property] = db.properties.splice(at, 1)
    db.properties.splice(this.from, 0, property)
  }
}

export class AddSelectOption implements Command {
  readonly label = 'Add option'
  readonly optionId: string

  constructor(
    private readonly databaseId: string,
    private readonly propertyId: string,
    private readonly name: string,
    private readonly colour: string,
    optionId = newId(),
  ) {
    this.optionId = optionId
  }

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const property = db && findProperty(db, this.propertyId)
    if (!property) return
    if (!property.options) property.options = []
    if (property.options.some((o) => o.id === this.optionId)) return
    const option: SelectOption = { id: this.optionId, name: this.name, colour: this.colour }
    property.options.push(option)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const property = db && findProperty(db, this.propertyId)
    if (!property?.options) return
    property.options = property.options.filter((o) => o.id !== this.optionId)
  }
}

// --- rows ------------------------------------------------------------------

/**
 * Add a row.
 *
 * A row is a Page, so it gets a title, an empty first block for its body, and a
 * property bag. Creating it any other way would give the island two kinds of
 * thing to derive a plant from.
 */
export class AddRow implements Command {
  readonly label = 'New row'
  readonly rowId: string
  readonly firstBlockId: string

  constructor(
    private readonly databaseId: string,
    private readonly initial: Record<string, PropertyValue> = {},
    private readonly atIndex?: number,
    rowId = newId(),
    firstBlockId = newId(),
  ) {
    this.rowId = rowId
    this.firstBlockId = firstBlockId
  }

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const page = createPage(this.rowId, null)
    page.databaseId = this.databaseId
    page.properties = { ...this.initial }
    page.children.push(this.firstBlockId)
    draft.pages[this.rowId] = page
    draft.blocks[this.firstBlockId] = createBlock(this.firstBlockId, this.rowId, null)
    const at = this.atIndex ?? db.rows.length
    db.rows.splice(Math.max(0, Math.min(at, db.rows.length)), 0, this.rowId)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (db) db.rows = db.rows.filter((id) => id !== this.rowId)
    delete draft.blocks[this.firstBlockId]
    delete draft.pages[this.rowId]
  }
}

/**
 * Remove a row from its database.
 *
 * A soft delete. Section 5 forbids the game destroying real data and the same
 * principle applies to the workspace half: the row leaves every query, but the
 * page and its blocks stay in the store so the trash can restore them intact.
 */
export class DeleteRow implements Command {
  readonly label = 'Delete row'
  private index = -1
  private captured = false

  constructor(private readonly databaseId: string, private readonly rowId: string) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const page = draft.pages[this.rowId]
    if (!db || !page) return
    if (!this.captured) {
      this.index = db.rows.indexOf(this.rowId)
      this.captured = true
    }
    page.trashed = true
    db.rows = db.rows.filter((id) => id !== this.rowId)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const page = draft.pages[this.rowId]
    if (!db || !page || !this.captured) return
    page.trashed = false
    db.rows.splice(Math.max(0, Math.min(this.index, db.rows.length)), 0, this.rowId)
  }
}

export class SetPropertyValue implements Command {
  private before: PropertyValue | undefined
  private captured = false

  constructor(
    private readonly rowId: string,
    private readonly propertyId: string,
    private readonly value: PropertyValue,
    readonly label = 'Edit cell',
  ) {}

  apply(draft: WorkspaceState): void {
    const page = draft.pages[this.rowId]
    if (!page) return
    if (!page.properties) page.properties = {}
    if (!this.captured) {
      // Detached, not the draft proxy: it has to survive past this produce.
      this.before = clonePropertyValue(page.properties[this.propertyId])
      this.captured = true
    }
    page.properties[this.propertyId] = this.value
    page.updatedAt = Date.now()
  }

  invert(draft: WorkspaceState): void {
    const page = draft.pages[this.rowId]
    if (!page?.properties || !this.captured) return
    if (this.before === undefined) delete page.properties[this.propertyId]
    else page.properties[this.propertyId] = this.before
  }
}

export class ReorderRow implements Command {
  readonly label = 'Move row'
  private from = -1
  private moved = false

  constructor(
    private readonly databaseId: string,
    private readonly rowId: string,
    private readonly toIndex: number,
  ) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const from = db.rows.indexOf(this.rowId)
    if (from === -1) return
    this.from = from
    this.moved = true
    db.rows.splice(from, 1)
    db.rows.splice(Math.max(0, Math.min(this.toIndex, db.rows.length)), 0, this.rowId)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db || !this.moved) return
    const at = db.rows.indexOf(this.rowId)
    if (at === -1) return
    db.rows.splice(at, 1)
    db.rows.splice(this.from, 0, this.rowId)
  }
}

// --- views -----------------------------------------------------------------

export class AddView implements Command {
  readonly viewId: string

  constructor(
    private readonly databaseId: string,
    private readonly name: string,
    private readonly kind: ViewKind,
    viewId = newId(),
  ) {
    this.viewId = viewId
  }

  get label(): string { return `Add ${this.name} view` }

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db) return
    const view = createView(this.viewId, this.name, this.kind, db.properties.map((p) => p.id))
    // Give each kind the property it cannot function without, picked from what
    // the schema already has - a Board with no grouping is a single column.
    if (this.kind === 'board') {
      view.groupBy = db.properties.find((p) => p.type === 'status' || p.type === 'select')?.id
    }
    if (this.kind === 'calendar' || this.kind === 'timeline') {
      view.dateProperty = db.properties.find((p) => p.type === 'date')?.id
    }
    if (this.kind === 'gallery') {
      view.coverProperty = db.properties.find((p) => p.type === 'files')?.id
    }
    db.views.push(view)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (db) db.views = db.views.filter((v) => v.id !== this.viewId)
  }
}

export class DeleteView implements Command {
  readonly label = 'Delete view'
  private snapshot: View | null = null
  private index = -1
  private captured = false

  constructor(private readonly databaseId: string, private readonly viewId: string) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db || db.views.length <= 1) return // never leave a database unviewable
    const index = db.views.findIndex((v) => v.id === this.viewId)
    if (index === -1) return
    if (!this.captured) {
      this.index = index
      this.snapshot = cloneView(db.views[index])
      this.captured = true
    }
    db.views.splice(index, 1)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    if (!db || !this.snapshot) return
    db.views.splice(this.index, 0, cloneView(this.snapshot))
  }
}

/**
 * Change a view's configuration.
 *
 * One command for filters, sorts, grouping and visible properties rather than
 * four, because they are edited from the same popover and a user who adds a
 * filter and a sort thinks of it as one change to one view.
 */
export class UpdateView implements Command {
  private before: View | null = null
  private captured = false

  constructor(
    private readonly databaseId: string,
    private readonly viewId: string,
    private readonly patch: Partial<View>,
    readonly label = 'Update view',
  ) {}

  apply(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const view = viewIn(db, this.viewId)
    if (!view) return
    if (!this.captured) { this.before = cloneView(view); this.captured = true }
    Object.assign(view, this.patch)
  }

  invert(draft: WorkspaceState): void {
    const db = draft.databases[this.databaseId]
    const index = db?.views.findIndex((v) => v.id === this.viewId) ?? -1
    if (!db || index === -1 || !this.before) return
    db.views[index] = cloneView(this.before)
  }
}

export function addFilterRule(view: View, rule: FilterNode): FilterGroup {
  return { ...view.filter, children: [...view.filter.children.map(cloneFilter), cloneFilter(rule)] }
}

export function removeFilterNode(group: FilterGroup, id: string): FilterGroup {
  return {
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === 'group' ? removeFilterNode(child, id) : { ...child })),
  }
}

export function replaceFilterNode(group: FilterGroup, id: string, next: FilterNode): FilterGroup {
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === id) return cloneFilter(next)
      return child.kind === 'group' ? replaceFilterNode(child, id, next) : { ...child }
    }),
  }
}

export function toggleSort(sorts: SortRule[], propertyId: string): SortRule[] {
  const existing = sorts.find((s) => s.propertyId === propertyId)
  if (!existing) return [...sorts, { propertyId, direction: 'asc' }]
  if (existing.direction === 'asc') {
    return sorts.map((s) => (s.propertyId === propertyId ? { ...s, direction: 'desc' as const } : s))
  }
  // Third click clears it, so a header cycles asc -> desc -> off.
  return sorts.filter((s) => s.propertyId !== propertyId)
}
