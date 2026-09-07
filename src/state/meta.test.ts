import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { CommandStack, SetMeta } from './commands'
import { createWorkspace, type WorkspaceState } from './types'

/**
 * `SetMeta` captured its before-value by reference. For the string and boolean
 * keys it had always been used with that was fine; for `keeper` - an object -
 * it would have captured a live Immer draft, revoked the moment the produce
 * ended, and undo would have thrown. The same bug that broke undo for dates and
 * multi-selects, waiting on a key nobody had set yet.
 */
describe('SetMeta', () => {
  const make = () => {
    let state: WorkspaceState = createWorkspace('meta', 1_700_000_000_000)
    const stack = new CommandStack((m) => { state = produce(state, m) })
    return { stack, get: () => state }
  }

  it('sets and undoes a primitive', () => {
    const { stack, get } = make()
    stack.execute(new SetMeta('isleName', 'Thornwick'))
    expect(get().meta.isleName).toBe('Thornwick')
    stack.undo()
    expect(get().meta.isleName).toBe('')
  })

  it('sets and undoes an object value without touching a revoked draft', () => {
    const { stack, get } = make()
    const original = get().meta.keeper
    const dressed = { name: 'Wren', colours: { body: '#111111', hair: '#222222', outfit: '#333333' } }

    stack.execute(new SetMeta('keeper', dressed))
    expect(get().meta.keeper.name).toBe('Wren')

    // A second edit, so the first command's captured value is definitely from
    // a produce that has since finished.
    stack.execute(new SetMeta('keeper', { ...dressed, name: 'Ash' }))
    expect(get().meta.keeper.name).toBe('Ash')

    expect(() => stack.undo()).not.toThrow()
    expect(get().meta.keeper.name).toBe('Wren')
    expect(() => stack.undo()).not.toThrow()
    expect(get().meta.keeper).toEqual(original)
  })

  it('does not alias the captured object with live state', () => {
    const { stack, get } = make()
    stack.execute(new SetMeta('keeper', { name: 'A', colours: { body: '#000000', hair: '#000000', outfit: '#000000' } }))
    stack.execute(new SetMeta('keeper', { name: 'B', colours: { body: '#000000', hair: '#000000', outfit: '#000000' } }))
    stack.execute(new SetMeta('keeper', { name: 'C', colours: { body: '#000000', hair: '#000000', outfit: '#000000' } }))
    stack.undo()
    expect(get().meta.keeper.name).toBe('B')
    stack.undo()
    expect(get().meta.keeper.name).toBe('A')
    stack.redo()
    expect(get().meta.keeper.name).toBe('B')
  })
})
