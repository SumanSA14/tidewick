import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { CreatePage } from '@/state/blockCommands'
import { CreateDatabase, AddProperty, AddView } from '@/state/databaseCommands'
import { BlockEditor } from '@/editor/BlockEditor'
import { DatabaseView } from '@/db/DatabaseView'

/**
 * The workspace half.
 *
 * Section 13 is explicit that this must be completely usable without ever
 * entering the island - someone who cannot or does not want a 3D view still
 * gets the whole tool. So nothing here reaches into the renderer, and the only
 * thing the two halves share is the store.
 */

export interface WorkspaceProps {
  accent: string
  /** A page the island asked to open, e.g. from clicking a plant. */
  initialPageId?: string | null
  /**
   * Something the command palette asked to open. Carries a nonce so asking for
   * the same page twice in a row still navigates the second time.
   */
  requestedTarget?: { kind: 'page' | 'database'; id: string; nonce: number } | null
  /** The page currently showing, for the app's Markdown export. */
  onCurrentPage?(pageId: string | null): void
  /** Open the command palette (Ctrl+K also works anywhere). */
  onSearch?(): void
  onSettings?(): void
  onLeave(): void
  onToIsle(): void
}

export function Workspace({
  accent, initialPageId, requestedTarget, onCurrentPage, onSearch, onSettings, onLeave, onToIsle,
}: WorkspaceProps) {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const undo = useWorkspaceStore((s) => s.undo)
  const redo = useWorkspaceStore((s) => s.redo)
  const canUndo = useWorkspaceStore((s) => s.canUndo)
  const canRedo = useWorkspaceStore((s) => s.canRedo)

  const pages = useMemo(
    () => workspace.pageOrder.map((id) => workspace.pages[id]).filter(Boolean),
    [workspace.pageOrder, workspace.pages],
  )

  const databases = useMemo(
    () => Object.values(workspace.databases).sort((a, b) => a.createdAt - b.createdAt),
    [workspace.databases],
  )

  // What the main pane is showing. A row opened from a view is still a page,
  // so "open a row" and "open a page" are the same target.
  const [target, setTarget] = useState<{ kind: 'page' | 'database'; id: string } | null>(
    pages[0] ? { kind: 'page', id: pages[0].id } : null,
  )
  const currentId = target?.kind === 'page' ? target.id : null

  // Guards the lazy first-page creation below. React StrictMode invokes effects
  // twice in development, and without this the very first visit to an empty
  // workspace creates two pages - the second one dispatched before the store
  // update from the first has propagated back through the memo.
  const seeding = useRef(false)

  // Every workspace needs somewhere to write. Creating the first page lazily,
  // on arrival, keeps the founding flow free of an empty document nobody asked
  // for, and keeps `createWorkspace` a pure function with no side effects.
  useEffect(() => {
    if (pages.length > 0) {
      seeding.current = false
      const stillThere = target && (target.kind === 'page'
        ? workspace.pages[target.id]
        : workspace.databases[target.id])
      if (!stillThere) setTarget({ kind: 'page', id: pages[0].id })
      return
    }
    if (seeding.current) return
    seeding.current = true
    const create = new CreatePage(null)
    dispatch(create)
    setTarget({ kind: 'page', id: create.pageId })
  }, [pages, target, workspace.pages, workspace.databases, dispatch])

  // Opening a plant navigates here. The row and the page are the same entity,
  // so there is nothing to translate - the island hands over a page id.
  useEffect(() => {
    if (initialPageId && workspace.pages[initialPageId]) {
      setTarget({ kind: 'page', id: initialPageId })
    }
  }, [initialPageId, workspace.pages])

  // The palette's pick. Keyed on the nonce, not the id, so re-picking the
  // page you are already on is still a navigation and not a no-op.
  useEffect(() => {
    if (!requestedTarget) return
    const exists = requestedTarget.kind === 'page'
      ? workspace.pages[requestedTarget.id]
      : workspace.databases[requestedTarget.id]
    if (exists) setTarget({ kind: requestedTarget.kind, id: requestedTarget.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTarget?.nonce])

  useEffect(() => {
    onCurrentPage?.(currentId)
  }, [currentId, onCurrentPage])

  const addPage = useCallback(() => {
    const create = new CreatePage(null)
    dispatch(create)
    setTarget({ kind: 'page', id: create.pageId })
  }, [dispatch])

  /**
   * A new database arrives with a usable schema rather than a single Name
   * column. An empty database is a blank stare; a Status, a Due date and a
   * Board view is something you can immediately put work into - and it is what
   * makes the island have anything to derive from in Phase 4.
   */
  const addDatabase = useCallback(() => {
    const create = new CreateDatabase('Untitled database')
    dispatch(create)
    dispatch(new AddProperty(create.databaseId, 'status', 'Status'))
    dispatch(new AddProperty(create.databaseId, 'date', 'Due'))
    dispatch(new AddView(create.databaseId, 'Board', 'board'))
    setTarget({ kind: 'database', id: create.databaseId })
  }, [dispatch])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return (
    <div className="workspace" style={{ ['--accent' as string]: accent }}>
      <aside className="sidebar" aria-label="Pages">
        <div className="sidebar__head">
          <button type="button" className="sidebar__isle" onClick={onLeave}>
            <img className="sidebar__mark" src="/logo.svg" alt="" width="18" height="18" />
            {workspace.meta.isleName || 'Tidewick'}
          </button>
          {onSearch && (
            <button type="button" className="sidebar__search" onClick={onSearch}>
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
          )}
        </div>

        <nav className="sidebar__pages">
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              className={`sidebar__page${page.id === currentId ? ' is-current' : ''}`}
              aria-current={page.id === currentId ? 'page' : undefined}
              onClick={() => setTarget({ kind: 'page', id: page.id })}
            >
              {page.title || 'Untitled'}
            </button>
          ))}

          {databases.length > 0 && <p className="sidebar__section">Databases</p>}
          {databases.map((database) => (
            <button
              key={database.id}
              type="button"
              className={`sidebar__page${target?.kind === 'database' && target.id === database.id ? ' is-current' : ''}`}
              aria-current={target?.kind === 'database' && target.id === database.id ? 'page' : undefined}
              onClick={() => setTarget({ kind: 'database', id: database.id })}
            >
              {database.name || 'Untitled database'}
            </button>
          ))}

          <button type="button" className="sidebar__add" onClick={addPage}>
            + New page
          </button>
          <button type="button" className="sidebar__add" onClick={addDatabase}>
            + New database
          </button>
        </nav>

        <div className="sidebar__foot">
          <button type="button" className="sidebar__action" onClick={undo} disabled={!canUndo}>Undo</button>
          <button type="button" className="sidebar__action" onClick={redo} disabled={!canRedo}>Redo</button>
          {onSettings && (
            <button type="button" className="sidebar__action" onClick={onSettings}>Settings</button>
          )}
          <button type="button" className="sidebar__action sidebar__action--isle" onClick={onToIsle}>
            The isle <kbd>Tab</kbd>
          </button>
        </div>
      </aside>

      <div className="workspace__main">
        {target?.kind === 'database'
          ? <DatabaseView
              databaseId={target.id}
              onOpenRow={(rowId) => setTarget({ kind: 'page', id: rowId })}
            />
          : currentId
            ? <BlockEditor pageId={currentId} />
            : null}
      </div>
    </div>
  )
}
