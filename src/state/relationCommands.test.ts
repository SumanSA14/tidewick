import { describe, it, expect, beforeEach } from 'vitest'
import { produce } from 'immer'
import { CommandStack } from './commands'
import { createWorkspace, type WorkspaceState } from './types'
import { CreateDatabase, AddRow, DeleteRow } from './databaseCommands'
import { AddRelation, SetRelation, collectLinks } from './relationCommands'
import { readStringArray, findProperty } from './database'
import { derive } from '@/island/derive'

/**
 * Bidirectional relations.
 *
 * The symmetry has to survive every operation, because a half-maintained
 * inverse is worse than no inverse at all: rollups quietly undercount and, from
 * Phase 4 onward, footpaths appear on one side of the island only.
 */
describe('relations', () => {
  let state: WorkspaceState
  let stack: CommandStack
  let apps: string
  let contacts: string
  let relation: AddRelation

  const run = (mutate: (d: WorkspaceState) => void) => { state = produce(state, mutate) }
  const addRow = (dbId: string, title: string) => {
    const command = new AddRow(dbId)
    stack.execute(command)
    run((draft) => { draft.pages[command.rowId].title = title })
    return command.rowId
  }

  beforeEach(() => {
    state = createWorkspace('ws', 1_700_000_000_000)
    stack = new CommandStack(run)

    const a = new CreateDatabase('Applications')
    stack.execute(a)
    apps = a.databaseId

    const c = new CreateDatabase('Referrals')
    stack.execute(c)
    contacts = c.databaseId

    relation = new AddRelation(apps, contacts, 'Referral', 'Applications')
    stack.execute(relation)
  })

  it('creates both sides of the pair', () => {
    const forward = findProperty(state.databases[apps], relation.propertyId)!
    const backward = findProperty(state.databases[contacts], relation.inverseId)!

    expect(forward.relationDatabaseId).toBe(contacts)
    expect(forward.inversePropertyId).toBe(relation.inverseId)
    expect(backward.relationDatabaseId).toBe(apps)
    expect(backward.inversePropertyId).toBe(relation.propertyId)
  })

  it('removes both sides on undo', () => {
    stack.undo()
    expect(findProperty(state.databases[apps], relation.propertyId)).toBeUndefined()
    expect(findProperty(state.databases[contacts], relation.inverseId)).toBeUndefined()
  })

  it('does not add a second column for a self-relation', () => {
    const self = new AddRelation(apps, apps, 'Blocks', 'Blocked by')
    stack.execute(self)
    const matching = state.databases[apps].properties.filter((p) => p.type === 'relation' && p.name === 'Blocked by')
    // One column that mirrors itself is a mess; a self-relation needs one side.
    expect(matching).toHaveLength(0)
  })

  describe('maintaining the inverse', () => {
    it('adds the back-reference when a link is made', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')

      stack.execute(new SetRelation(app, relation.propertyId, [contact]))

      expect(readStringArray(state.pages[app].properties?.[relation.propertyId])).toEqual([contact])
      expect(readStringArray(state.pages[contact].properties?.[relation.inverseId])).toEqual([app])
    })

    it('removes the back-reference when a link is dropped', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      stack.execute(new SetRelation(app, relation.propertyId, []))

      expect(readStringArray(state.pages[contact].properties?.[relation.inverseId])).toEqual([])
    })

    it('handles an edit that adds and removes at once', () => {
      const app = addRow(apps, 'Company A')
      const first = addRow(contacts, 'Referrer 1')
      const second = addRow(contacts, 'Referrer 2')

      stack.execute(new SetRelation(app, relation.propertyId, [first]))
      stack.execute(new SetRelation(app, relation.propertyId, [second]))

      expect(readStringArray(state.pages[first].properties?.[relation.inverseId])).toEqual([])
      expect(readStringArray(state.pages[second].properties?.[relation.inverseId])).toEqual([app])
    })

    it('restores both sides exactly on undo', () => {
      const app = addRow(apps, 'Company A')
      const first = addRow(contacts, 'Referrer 1')
      const second = addRow(contacts, 'Referrer 2')

      stack.execute(new SetRelation(app, relation.propertyId, [first]))
      stack.execute(new SetRelation(app, relation.propertyId, [second]))
      stack.undo()

      // Recomputing the inverse from the new value alone cannot do this: the
      // edit both added and removed, so the reverse is not derivable from it.
      expect(readStringArray(state.pages[first].properties?.[relation.inverseId])).toEqual([app])
      expect(readStringArray(state.pages[second].properties?.[relation.inverseId])).toEqual([])
    })

    it('links to several rows at once', () => {
      const app = addRow(apps, 'Company A')
      const a = addRow(contacts, 'One')
      const b = addRow(contacts, 'Two')
      stack.execute(new SetRelation(app, relation.propertyId, [a, b]))

      expect(readStringArray(state.pages[a].properties?.[relation.inverseId])).toEqual([app])
      expect(readStringArray(state.pages[b].properties?.[relation.inverseId])).toEqual([app])
    })

    it('does not duplicate a back-reference set twice', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      expect(readStringArray(state.pages[contact].properties?.[relation.inverseId])).toEqual([app])
    })
  })

  describe('collectLinks', () => {
    it('counts a mirrored link once', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))

      // The link is stored on both sides; it is one footpath, not two.
      expect(collectLinks(state)).toHaveLength(1)
    })

    it('drops links whose other end was trashed', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      stack.execute(new DeleteRow(contacts, contact))
      expect(collectLinks(state)).toHaveLength(0)
    })
  })

  describe('footpaths on the island', () => {
    it('derives a path between the two plants', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))

      const snapshot = derive(state)
      expect(snapshot.paths).toHaveLength(1)
      const path = snapshot.paths[0]
      expect(snapshot.ids[path.from]).toBeDefined()
      expect(snapshot.ids[path.to]).toBeDefined()
      expect([snapshot.ids[path.from], snapshot.ids[path.to]].sort()).toEqual([app, contact].sort())
    })

    it('gives a freshly touched link full traffic', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      expect(derive(state).paths[0].traffic).toBeCloseTo(1, 2)
    })

    it('fades a link nobody has touched in weeks, without removing it', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))

      // Age both ends, then edit something else so "newest" moves on.
      run((draft) => {
        draft.pages[app].updatedAt -= 40 * 86_400_000
        draft.pages[contact].updatedAt -= 40 * 86_400_000
      })
      addRow(apps, 'Company B')

      const path = derive(state).paths[0]
      expect(path.traffic).toBe(0)
      // Still there. The link is real even when it is quiet.
      expect(derive(state).paths).toHaveLength(1)
    })

    it('changes the island revision when a link is made', () => {
      const app = addRow(apps, 'Company A')
      const contact = addRow(contacts, 'Referrer 1')
      const before = derive(state).revision
      stack.execute(new SetRelation(app, relation.propertyId, [contact]))
      expect(derive(state).revision).not.toBe(before)
    })
  })
})
