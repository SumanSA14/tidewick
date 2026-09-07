import { create } from 'zustand'
import { produce, enablePatches, type Patch } from 'immer'
import { createWorkspace, type WorkspaceState } from './types'
import { CommandStack, type Command } from './commands'
import { saveWorkspace } from './persistence'

enablePatches()

/**
 * The workspace store.
 *
 * Zustand for the subscription surface, Immer for structural sharing. The store
 * exposes no setters: the only way in is `dispatch(command)`, which keeps the
 * promise that there is exactly one mutation path shared by the DOM interface
 * and, from Phase 6, the Keeper.
 *
 * Immer patches are collected on every mutation. Phase 4 feeds them to the
 * derivation worker as a dirty set, so the island recomputes only the entities
 * whose inputs actually changed rather than re-deriving the world on every
 * keystroke. Collecting them now costs nothing and means the plumbing is
 * already in place when derive() arrives.
 */

export interface StoreShape {
  workspace: WorkspaceState
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  /** Patches from the most recent mutation. Consumed by the derivation bridge. */
  lastPatches: Patch[]
  dispatch(command: Command): void
  /** Re-apply the command on top of the stack without a new history entry. */
  amend(command: Command): void
  undo(): void
  redo(): void
  /**
   * Replace the whole workspace, e.g. after loading from disk. Clears history.
   * `persist` writes it straight back, which is only correct for a workspace
   * being founded for the first time.
   */
  hydrate(state: WorkspaceState, persist?: boolean): void
}

let stack: CommandStack

export const useWorkspaceStore = create<StoreShape>((set, get) => {
  const run = (mutate: (draft: WorkspaceState) => void) => {
    const current = get().workspace
    let patches: Patch[] = []
    const next = produce(current, mutate, (p) => {
      patches = p
    })
    if (next === current) return
    set({ workspace: next, lastPatches: patches })
    saveWorkspace(next)
  }

  stack = new CommandStack(run)

  const syncHistory = () => {
    set({
      canUndo: stack.canUndo,
      canRedo: stack.canRedo,
      undoLabel: stack.undoLabel,
      redoLabel: stack.redoLabel,
    })
  }
  stack.onChange = syncHistory

  return {
    workspace: createWorkspace(newWorkspaceId()),
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    lastPatches: [],
    dispatch: (command) => stack.execute(command),
    amend: (command) => {
      // Falls back to a normal dispatch when the command is no longer on top,
      // which happens if anything else was dispatched mid-burst.
      if (!stack.amend(command)) stack.execute(command)
    },
    undo: () => { stack.undo() },
    redo: () => { stack.redo() },
    hydrate: (state, persist = false) => {
      stack.clear()
      set({ workspace: state, lastPatches: [] })
      // Persisting is opt-in. A workspace that was just *read* from disk must
      // not be written straight back, and a fresh one must only be written
      // when we are certain there was nothing there to begin with - see
      // LoadResult in persistence.ts for why that distinction matters.
      if (persist) saveWorkspace(state)
    },
  }
})

/**
 * A new workspace id.
 *
 * This is the single most consequential string in the app: the terrain seed is
 * a stable hash of it, so it decides the shape of the island forever. It is
 * therefore generated once and never derived from anything the user can edit -
 * renaming your isle must not bulldoze it.
 */
export function newWorkspaceId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Non-React access, for the render layer and workers. */
export function getWorkspace(): WorkspaceState {
  return useWorkspaceStore.getState().workspace
}
