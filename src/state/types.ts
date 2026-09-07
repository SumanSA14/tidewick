import type { Block, Page } from './blocks'
import type { Database } from './database'

/**
 * Workspace state.
 *
 * Everything the island is derived from lives here and nowhere else. There is
 * no parallel game save: if a value is not in this tree, the isle cannot show
 * it, and if it is here, the isle shows it without any sync code.
 *
 * Phase 2 grows this with blocks, pages and databases; Phase 4 starts deriving
 * from it. The shape is deliberately established now so that derive() has a
 * stable target rather than a moving one.
 */

export interface KeeperAppearance {
  name: string
  colours: {
    body: string
    hair: string
    outfit: string
  }
}

export interface WorkspaceMeta {
  /** Stable id. The terrain seed is a hash of this, so it never changes. */
  id: string
  /** What the user calls their isle. Display only - it does not reshape land. */
  isleName: string
  keeper: KeeperAppearance
  createdAt: number
  lastOpenedAt: number
  /** Index into the season palettes. Advances every SEASON_LENGTH_DAYS. */
  seasonIndex: number
  /** Completed tasks, ever. The island's only progress metric has no number
   *  on screen - but the count has to live somewhere to light the lanterns. */
  lanternsLit: number
  /** Minutes of measured, uninterrupted focus. The only source of Sunlight. */
  focusMinutes: number
  /**
   * Sunlight in reserve.
   *
   * Lives here rather than in a game store because of Section 2: there is no
   * parallel save file. It is also why Sunlight survives undo, export and
   * every other thing the workspace already knows how to do, for free.
   */
  sunlight: number
  /** The warmth multiplier, carried between sessions so it returns gradually. */
  warmth: number
  /** When the current season began. Drives the Harvest Festival. */
  seasonStartedAt: number
  /** Seasons completed. The keepsake pages are numbered from this. */
  seasonsHarvested: number
  onboarded: boolean
}

export interface WorkspaceState {
  meta: WorkspaceMeta
  /** Normalised entity tables. Flat on purpose: Phase 4's dirty set works at
   *  entity granularity, and a nested tree would make that impossible. */
  pages: Record<string, Page>
  blocks: Record<string, Block>
  databases: Record<string, Database>
  /** Ordered top-level page ids, for the sidebar. */
  pageOrder: string[]
}

export const SCHEMA_VERSION = 4

/** A fresh, unnamed workspace. No personal names anywhere - every name in the
 *  running app is typed by the user. */
export function createWorkspace(id: string, now = Date.now()): WorkspaceState {
  return {
    meta: {
      id,
      isleName: '',
      keeper: {
        name: '',
        colours: { body: '#e8c9a8', hair: '#4a3b32', outfit: '#3f8fa8' },
      },
      createdAt: now,
      lastOpenedAt: now,
      seasonIndex: 0,
      lanternsLit: 0,
      focusMinutes: 0,
      sunlight: 0,
      warmth: 1,
      seasonStartedAt: now,
      seasonsHarvested: 0,
      onboarded: false,
    },
    pages: {},
    blocks: {},
    databases: {},
    pageOrder: [],
  }
}
