import type { WorkspaceState } from './types'

/**
 * The single mutation path.
 *
 * Section 11 of the brief calls this non-negotiable and it is the load-bearing
 * decision in the whole project. Everything that changes workspace state - a
 * keystroke in the editor, a card dragged between board columns, and later the
 * Keeper tending a plant out on the island - constructs one of these and hands
 * it to the stack. Nothing writes to the store directly.
 *
 * The payoff arrives in Phase 6, when the world becomes an input surface: undo
 * works across both interfaces for free, because there is only ever one history
 * to undo. The alternative - island actions with their own code path - is the
 * bug factory this architecture exists to prevent.
 *
 * A command captures whatever it needs for `invert` during `apply`, so the
 * stack itself stores no snapshots.
 */
export interface Command {
  readonly label: string
  apply(draft: WorkspaceState): void
  invert(draft: WorkspaceState): void
}

export type CommandRunner = (mutate: (draft: WorkspaceState) => void) => void

export interface HistoryEntry {
  command: Command
  at: number
}

/**
 * Undo/redo over a linear history.
 *
 * Bounded, because an unbounded stack in a local-first app that people leave
 * open for days is a slow memory leak rather than a feature.
 */
export class CommandStack {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private readonly limit: number
  private readonly run: CommandRunner

  onChange: (() => void) | null = null

  constructor(run: CommandRunner, limit = 500) {
    this.run = run
    this.limit = limit
  }

  execute(command: Command): void {
    this.run((draft) => command.apply(draft))
    this.undoStack.push({ command, at: Date.now() })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    // Any new action invalidates the redo branch. Keeping it would let a user
    // redo their way into a state that never existed.
    this.redoStack.length = 0
    this.onChange?.()
  }

  /**
   * Re-run a command that is already on top of the stack, without pushing a
   * second history entry.
   *
   * This is what makes typing coalesce. A burst of keystrokes mutates one
   * SetBlockText in place and re-applies it; because the command captured its
   * before-state on the *first* apply, undo still steps back to the start of
   * the burst rather than one character. Dispatching normally instead would
   * push an entry per keystroke and make Ctrl+Z useless.
   */
  amend(command: Command): boolean {
    if (this.undoStack.at(-1)?.command !== command) return false
    this.run((draft) => command.apply(draft))
    return true
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.run((draft) => entry.command.invert(draft))
    this.redoStack.push(entry)
    this.onChange?.()
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.run((draft) => entry.command.apply(draft))
    this.undoStack.push(entry)
    this.onChange?.()
    return true
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.command.label ?? null
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.command.label ?? null
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.onChange?.()
  }
}

// --- Concrete commands -----------------------------------------------------

type MetaKey = keyof WorkspaceState['meta']

/** Set one field of workspace metadata. */
/** A plain copy of a meta value, safe to hold past the end of a produce. */
function detach<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

export class SetMeta<K extends MetaKey> implements Command {
  private before: WorkspaceState['meta'][K] | undefined
  private captured = false

  constructor(
    private readonly key: K,
    private readonly value: WorkspaceState['meta'][K],
    readonly label = `Change ${String(key)}`,
  ) {}

  apply(draft: WorkspaceState): void {
    // Capture once. Re-capturing on redo would record the value this command
    // itself wrote, and undo would then be a no-op.
    if (!this.captured) {
      // Detached from the draft. `meta.keeper` is an object, and capturing a
      // live Immer proxy here is the same bug that broke undo for dates and
      // multi-selects: the proxy is revoked when the produce ends and writing
      // it back on undo throws.
      this.before = detach(draft.meta[this.key])
      this.captured = true
    }
    draft.meta[this.key] = this.value
  }

  invert(draft: WorkspaceState): void {
    if (this.captured && this.before !== undefined) {
      draft.meta[this.key] = this.before
    }
  }
}

/** Set one of the Keeper's three colours. */
export class SetKeeperColour implements Command {
  private before: string | undefined
  private captured = false

  constructor(
    private readonly slot: keyof WorkspaceState['meta']['keeper']['colours'],
    private readonly value: string,
  ) {}

  get label(): string {
    return `Change ${this.slot} colour`
  }

  apply(draft: WorkspaceState): void {
    if (!this.captured) {
      this.before = draft.meta.keeper.colours[this.slot]
      this.captured = true
    }
    draft.meta.keeper.colours[this.slot] = this.value
  }

  invert(draft: WorkspaceState): void {
    if (this.captured && this.before !== undefined) {
      draft.meta.keeper.colours[this.slot] = this.before
    }
  }
}

/** Set the Keeper's name. */
export class SetKeeperName implements Command {
  private before = ''
  private captured = false
  readonly label = 'Name the Keeper'

  constructor(private readonly value: string) {}

  apply(draft: WorkspaceState): void {
    if (!this.captured) {
      this.before = draft.meta.keeper.name
      this.captured = true
    }
    draft.meta.keeper.name = this.value
  }

  invert(draft: WorkspaceState): void {
    if (this.captured) draft.meta.keeper.name = this.before
  }
}
