import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack, SetMeta, SetKeeperName, SetKeeperColour, type Command } from './commands'
import { createWorkspace, type WorkspaceState } from './types'

/**
 * The command stack is the load-bearing piece of the whole architecture: it is
 * what lets the island be an input surface in Phase 6 without a second mutation
 * path, and what makes undo work identically from both interfaces. It is worth
 * testing harder than its size suggests.
 */
describe('command stack', () => {
  let state: WorkspaceState
  let stack: CommandStack

  beforeEach(() => {
    state = createWorkspace('test-workspace', 1_700_000_000_000)
    stack = new CommandStack((mutate) => {
      state = produce(state, mutate)
    })
  })

  it('applies a command', () => {
    stack.execute(new SetMeta('isleName', 'Somewhere Quiet'))
    expect(state.meta.isleName).toBe('Somewhere Quiet')
  })

  it('undoes and redoes exactly', () => {
    stack.execute(new SetMeta('isleName', 'First'))
    stack.execute(new SetMeta('isleName', 'Second'))
    expect(state.meta.isleName).toBe('Second')

    stack.undo()
    expect(state.meta.isleName).toBe('First')
    stack.undo()
    expect(state.meta.isleName).toBe('')

    stack.redo()
    expect(state.meta.isleName).toBe('First')
    stack.redo()
    expect(state.meta.isleName).toBe('Second')
  })

  it('survives 100 undos and 100 redos exactly', () => {
    // Phase 2's acceptance criterion, checked here because the stack is the
    // thing that has to hold, not the editor on top of it.
    const original = state
    for (let i = 0; i < 100; i++) {
      stack.execute(new SetMeta('isleName', `isle ${i}`))
    }
    expect(state.meta.isleName).toBe('isle 99')

    for (let i = 0; i < 100; i++) stack.undo()
    expect(state.meta.isleName).toBe(original.meta.isleName)
    expect(stack.canUndo).toBe(false)

    for (let i = 0; i < 100; i++) stack.redo()
    expect(state.meta.isleName).toBe('isle 99')
    expect(stack.canRedo).toBe(false)
  })

  it('does not capture a fresh before-value on redo', () => {
    // A command that re-reads the previous value during redo records the value
    // it just wrote, and the following undo silently becomes a no-op. This is
    // the single most likely bug in a capture-on-apply design.
    stack.execute(new SetMeta('isleName', 'Named'))
    stack.undo()
    stack.redo()
    stack.undo()
    expect(state.meta.isleName).toBe('')
  })

  it('discards the redo branch when a new command is executed', () => {
    stack.execute(new SetMeta('isleName', 'A'))
    stack.execute(new SetMeta('isleName', 'B'))
    stack.undo()
    expect(stack.canRedo).toBe(true)

    stack.execute(new SetMeta('isleName', 'C'))
    // Keeping the branch would let a user redo into a state that never existed.
    expect(stack.canRedo).toBe(false)
    expect(state.meta.isleName).toBe('C')
  })

  it('reports nothing to undo or redo on an empty stack', () => {
    expect(stack.canUndo).toBe(false)
    expect(stack.canRedo).toBe(false)
    expect(stack.undo()).toBe(false)
    expect(stack.redo()).toBe(false)
    expect(stack.undoLabel).toBeNull()
  })

  it('bounds its history rather than growing without limit', () => {
    const bounded = new CommandStack((mutate) => { state = produce(state, mutate) }, 8)
    for (let i = 0; i < 30; i++) bounded.execute(new SetMeta('isleName', `n${i}`))
    let undone = 0
    while (bounded.undo()) undone++
    expect(undone).toBe(8)
  })

  it('exposes a human label for the next undo', () => {
    stack.execute(new SetMeta('isleName', 'Named', 'Name the isle'))
    expect(stack.undoLabel).toBe('Name the isle')
    stack.undo()
    expect(stack.redoLabel).toBe('Name the isle')
  })

  it('handles nested keeper fields', () => {
    stack.execute(new SetKeeperName('Wren'))
    stack.execute(new SetKeeperColour('hair', '#b98a4c'))
    expect(state.meta.keeper.name).toBe('Wren')
    expect(state.meta.keeper.colours.hair).toBe('#b98a4c')

    stack.undo()
    expect(state.meta.keeper.colours.hair).toBe('#4a3b32')
    expect(state.meta.keeper.name).toBe('Wren')
    stack.undo()
    expect(state.meta.keeper.name).toBe('')
  })

  it('leaves the workspace id alone no matter what is undone', () => {
    // The terrain seed hashes this id. If undo could reach it, undoing an edit
    // would silently reshape the island.
    const id = state.meta.id
    stack.execute(new SetMeta('isleName', 'A'))
    stack.execute(new SetKeeperName('B'))
    stack.undo()
    stack.undo()
    expect(state.meta.id).toBe(id)
  })

  it('treats state as immutable, sharing untouched branches', () => {
    const before = state
    const keeperBefore = state.meta.keeper
    stack.execute(new SetMeta('isleName', 'Named'))
    expect(state).not.toBe(before)
    expect(before.meta.isleName).toBe('')
    // Immer structural sharing: an untouched subtree keeps its identity, which
    // is what lets Phase 4 skip re-deriving entities whose inputs did not move.
    expect(state.meta.keeper).toBe(keeperBefore)
  })

  it('notifies on every change so the interface can track availability', () => {
    let calls = 0
    stack.onChange = () => { calls++ }
    stack.execute(new SetMeta('isleName', 'A'))
    stack.undo()
    stack.redo()
    stack.clear()
    expect(calls).toBe(4)
  })

  it('runs a custom command through the same path', () => {
    const lightLantern: Command = {
      label: 'Light a lantern',
      apply: (draft) => { draft.meta.lanternsLit += 1 },
      invert: (draft) => { draft.meta.lanternsLit -= 1 },
    }
    stack.execute(lightLantern)
    stack.execute(lightLantern)
    expect(state.meta.lanternsLit).toBe(2)
    stack.undo()
    expect(state.meta.lanternsLit).toBe(1)
  })
})

describe('workspace shape', () => {
  it('ships no personal names in a fresh workspace', () => {
    const w = createWorkspace('id')
    expect(w.meta.isleName).toBe('')
    expect(w.meta.keeper.name).toBe('')
    expect(w.meta.onboarded).toBe(false)
  })

  it('starts with nothing earned', () => {
    const w = createWorkspace('id')
    expect(w.meta.lanternsLit).toBe(0)
    expect(w.meta.focusMinutes).toBe(0)
  })
})
