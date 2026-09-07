import Dexie, { type Table } from 'dexie'
import { SCHEMA_VERSION, type WorkspaceState } from './types'

/**
 * Local-first persistence.
 *
 * Write-behind and debounced, per Section 11: the interface must never block on
 * IndexedDB. A keystroke in the editor should cost a store update and nothing
 * else; the disk catches up on its own schedule.
 *
 * Everything stays on the device. There is no sync endpoint to add later
 * without a deliberate decision, and the Tauri build's CSP forbids network
 * access outright, so that promise is enforced rather than merely documented.
 */

interface StoredWorkspace {
  id: string
  version: number
  savedAt: number
  state: WorkspaceState
}

class TidewickDatabase extends Dexie {
  workspaces!: Table<StoredWorkspace, string>

  constructor() {
    super('tidewick')
    this.version(1).stores({ workspaces: 'id, savedAt' })
  }
}

const db = new TidewickDatabase()

/** Debounce window. Long enough to coalesce typing, short enough that a crash
 *  or a closed lid loses at most a sentence. */
const WRITE_DELAY_MS = 400

let pending: WorkspaceState | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> = Promise.resolve()

export function saveWorkspace(state: WorkspaceState): void {
  pending = state
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const snapshot = pending
    pending = null
    if (!snapshot) return
    inFlight = writeNow(snapshot)
  }, WRITE_DELAY_MS)
}

async function writeNow(state: WorkspaceState): Promise<void> {
  try {
    await db.workspaces.put({
      id: state.meta.id,
      version: SCHEMA_VERSION,
      savedAt: Date.now(),
      state,
    })
  } catch (err) {
    // A failed write must not take the session with it. Private-browsing modes
    // and storage-blocked profiles both land here, and the app is still
    // perfectly usable in memory for as long as the tab is open.
    console.warn('[tidewick] could not persist workspace', err)
  }
}

/** Force any pending write to disk. Used before the window unloads. */
export async function flushWorkspace(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const snapshot = pending
  pending = null
  if (snapshot) inFlight = writeNow(snapshot)
  await inFlight
}

/**
 * Bring a stored workspace up to the current schema.
 *
 * Refusing to load an old version is the easy option and it is the wrong one:
 * a local-first app has no server copy to fall back on, so a rejected load is
 * simply lost work. Migrations run forward one version at a time and an
 * unrecognised *future* version is the only case that returns null - that means
 * the file was written by a newer build, and guessing at it would corrupt it.
 */
function migrate(row: StoredWorkspace): WorkspaceState | null {
  let { version, state } = row

  if (version === 1) {
    // v2 introduced pages and blocks. A v1 workspace has neither, and empty
    // tables are exactly the right starting point.
    state = { ...state, pages: {}, blocks: {}, pageOrder: [] }
    version = 2
  }

  if (version === 2) {
    // v3 introduced user-defined databases.
    state = { ...state, databases: {} }
    version = 3
  }

  if (version === 3) {
    // v4 introduced the Sunlight economy and season bookkeeping. An existing
    // isle starts with an empty reserve and its season beginning now: back-
    // dating it would fire a Harvest Festival on first launch for a workspace
    // that never had a season, which is a celebration nobody earned.
    state = {
      ...state,
      meta: {
        ...state.meta,
        sunlight: 0,
        warmth: 1,
        seasonStartedAt: state.meta?.createdAt ?? Date.now(),
        seasonsHarvested: 0,
      },
    }
    version = 4
  }

  if (version !== SCHEMA_VERSION) {
    console.warn(`[tidewick] workspace schema ${row.version} is newer than ${SCHEMA_VERSION}; refusing to guess`)
    return null
  }

  // Defensive: a hand-edited or partially-written row should not crash the app.
  if (!state.pages) state = { ...state, pages: {} }
  if (!state.blocks) state = { ...state, blocks: {} }
  if (!state.pageOrder) state = { ...state, pageOrder: [] }
  if (!state.databases) state = { ...state, databases: {} }

  return state
}

export async function loadWorkspace(id: string): Promise<WorkspaceState | null> {
  try {
    const row = await db.workspaces.get(id)
    if (!row) return null
    return migrate(row)
  } catch (err) {
    console.warn('[tidewick] could not read workspace', err)
    return null
  }
}

/**
 * The most recently saved workspace, for resuming on launch.
 *
 * Deliberately tri-state. Returning `null` for both "nothing saved yet" and
 * "the read failed" looks harmless and is not: the caller then founds a brand
 * new workspace, saves it, and because it is now the most recent row it
 * shadows the real one on every subsequent launch. A blocked IndexedDB, a
 * transient 504 during dev, or a private window is enough to silently orphan
 * someone's island. So the failure case is named, and the caller must decide
 * what to do about it.
 */
export type LoadResult =
  | { status: 'ok'; state: WorkspaceState }
  | { status: 'empty' }
  | { status: 'error'; error: unknown }

export async function loadMostRecent(): Promise<LoadResult> {
  try {
    const rows = await db.workspaces.orderBy('savedAt').reverse().limit(1).toArray()
    const row = rows[0]
    if (!row) return { status: 'empty' }
    const state = migrate(row)
    return state ? { status: 'ok', state } : { status: 'error', error: 'unmigratable schema' }
  } catch (error) {
    console.warn('[tidewick] could not list workspaces', error)
    return { status: 'error', error }
  }
}

export async function listWorkspaces(): Promise<Array<{ id: string; isleName: string; savedAt: number }>> {
  try {
    const rows = await db.workspaces.orderBy('savedAt').reverse().toArray()
    return rows.map((r) => ({ id: r.id, isleName: r.state.meta.isleName, savedAt: r.savedAt }))
  } catch {
    return []
  }
}
