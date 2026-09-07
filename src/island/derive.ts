import type { WorkspaceState } from '@/state/types'
import type { Page } from '@/state/blocks'
import {
  readNumber, readStringArray, readBoolean, dateToMillis,
  type Database, type PropertyDef,
} from '@/state/database'
import { hashString } from '@/core/hash'
import { collectLinks } from '@/state/relationCommands'
import { ELEVATION_HORIZON_DAYS } from '@/core/config'

/**
 * derive(WorkspaceState) -> IslandSnapshot
 *
 * The one rule, in code. This function is pure: same workspace in, same island
 * out, no clock, no randomness, no reads of anything outside its arguments. The
 * island holds no state of its own, so it cannot drift out of sync with reality
 * - there is nothing to drift.
 *
 * Note what is deliberately *absent*: a plant's position. Elevation is a
 * function of how long is left before a task is due, which changes every
 * second; baking a position here would mean re-deriving the world constantly to
 * animate the drift. Instead each plant carries its due date, and the vertex
 * shader places it against the terrain profile for whatever `now` is. Downhill
 * drift is then continuous and free rather than a simulation step, and this
 * function stays clock-free and therefore testable.
 */

export const MS_PER_DAY = 86_400_000

/** Growth stages. The order matters: it is also the visual progression. */
export const STAGE = {
  seed: 0,
  sapling: 1,
  bloom: 2,
  lantern: 3,
} as const

export type Stage = typeof STAGE[keyof typeof STAGE]

export interface RegionInfo {
  /** Database id, or the sentinel for loose pages. */
  sourceId: string
  name: string
  index: number
  /** Angular wedge, radians. */
  angleStart: number
  angleEnd: number
  /** Palette index, so a region keeps its character across seasons. */
  palette: number
  plantCount: number
}

/**
 * Which property means what, for the island.
 *
 * The engine hard-codes no domain, so a database has to say which of its
 * columns is the due date and which is the status. These are inferred from the
 * schema when unset - a database with one Date property has an obvious answer -
 * and Phase 7 lets the user override it. Guessing is much better than a blank
 * island while someone hunts for a settings panel.
 */
export interface IslandMapping {
  dueProperty?: string
  statusProperty?: string
  speciesProperty?: string
  scaleProperty?: string
}

export function inferMapping(database: Database): IslandMapping {
  const byType = (type: PropertyDef['type']) => database.properties.find((p) => p.type === type)?.id
  return {
    dueProperty: byType('date'),
    statusProperty: byType('status') ?? byType('checkbox'),
    speciesProperty: byType('select') ?? byType('multiSelect'),
    scaleProperty: byType('number'),
  }
}

/** The sentinel region for pages that belong to no database. */
export const LOOSE_PAGES_REGION = '__pages__'

/**
 * A footpath between two plants.
 *
 * Section 4 maps a relation to a path, with foot traffic proportional to recent
 * cross-linked activity. Stored as endpoint *indices* rather than page ids, so
 * the renderer can look up both ends in the instance arrays without a map.
 */
export interface Footpath {
  from: number
  to: number
  /** 0..1, from how recently either end was touched. */
  traffic: number
}

export interface IslandSnapshot {
  regions: RegionInfo[]
  count: number
  paths: Footpath[]

  // Structure of arrays, sized to `count`, ready to become GPU buffers.
  /** Absolute angle around the isle, radians. */
  angle: Float32Array
  /** Due date in epoch ms, or NO_DUE_DATE for work with no deadline. */
  due: Float32Array
  /** Jitter in [0,1) so plants in a wedge are not in a line. */
  jitter: Float32Array
  species: Uint8Array
  stage: Uint8Array
  scale: Float32Array
  regionIndex: Uint8Array
  /** Stable per-entity id, used by GPU picking to name what was clicked. */
  entityId: Uint32Array

  /** entityId -> page id, so a pick can be turned back into a Command. */
  ids: string[]
  /** Content hash, so the bridge can tell whether anything actually changed. */
  revision: number
}

/**
 * Sentinel for undated work.
 *
 * Undated tasks live in a flat inland meadow, off the time gradient entirely.
 * Section 3.2 is emphatic about this and it is a design position, not an edge
 * case: not everything needs a deadline, and an island that forces every task
 * onto the slope would be telling its user otherwise.
 */
export const NO_DUE_DATE = -1

/**
 * A fresh empty snapshot.
 *
 * `derive` must return one of these rather than the `EMPTY_SNAPSHOT` constant,
 * and the reason is not tidiness. The derive worker transfers every typed
 * array to the main thread, which *detaches* the underlying buffers in the
 * worker. Handing out a module-level singleton meant the second empty derive
 * tried to transfer buffers that were already detached and threw
 * `DataCloneError` - and from then on the island silently stopped updating for
 * the rest of the session.
 *
 * It only bites a workspace with no databases, which is to say a brand-new one,
 * which is to say the very first thing a new user sees.
 */
export function emptySnapshot(): IslandSnapshot {
  return {
    regions: [],
    count: 0,
    paths: [],
    angle: new Float32Array(0),
    due: new Float32Array(0),
    jitter: new Float32Array(0),
    species: new Uint8Array(0),
    stage: new Uint8Array(0),
    scale: new Float32Array(0),
    regionIndex: new Uint8Array(0),
    entityId: new Uint32Array(0),
    ids: [],
    revision: 0,
  }
}

/**
 * A shared empty snapshot, for initial values and comparisons only.
 *
 * Never return this from anything whose result may be posted to a worker.
 */
export const EMPTY_SNAPSHOT: IslandSnapshot = {
  regions: [],
  count: 0,
  paths: [],
  angle: new Float32Array(0),
  due: new Float32Array(0),
  jitter: new Float32Array(0),
  species: new Uint8Array(0),
  stage: new Uint8Array(0),
  scale: new Float32Array(0),
  regionIndex: new Uint8Array(0),
  entityId: new Uint32Array(0),
  ids: [],
  revision: 0,
}

/** How much of the isle is reserved for the undated meadow. */
const MEADOW_WEDGE_FRACTION = 0.18

export function derive(state: WorkspaceState): IslandSnapshot {
  const sources = collectSources(state)
  if (sources.length === 0) return emptySnapshot()

  // Reserve a wedge for the meadow, then split the rest between the sources.
  // Adding a project therefore narrows every other region rather than
  // overlapping one - "creating a project reclaims land from the sea".
  const meadowSpan = Math.PI * 2 * MEADOW_WEDGE_FRACTION
  const available = Math.PI * 2 - meadowSpan
  const span = available / sources.length

  const regions: RegionInfo[] = []
  const records: PlantRecord[] = []

  sources.forEach((source, index) => {
    const angleStart = meadowSpan + index * span
    const angleEnd = angleStart + span
    // Palette from the source id, so a region keeps its character no matter
    // how many siblings arrive later and shuffle the indices.
    const palette = hashString(source.id) % 8

    let plantCount = 0
    for (const page of source.pages) {
      const record = plantFor(page, source, index, angleStart, angleEnd)
      if (!record) continue
      records.push(record)
      plantCount++
    }

    regions.push({
      sourceId: source.id,
      name: source.name,
      index,
      angleStart,
      angleEnd,
      palette,
      plantCount,
    })
  })

  return pack(regions, records, state)
}

/** Activity older than this contributes no foot traffic. */
const TRAFFIC_WINDOW_DAYS = 14

// --- gathering -------------------------------------------------------------

interface Source {
  id: string
  name: string
  pages: Page[]
  mapping: IslandMapping
  database?: Database
}

function collectSources(state: WorkspaceState): Source[] {
  const sources: Source[] = []

  const databases = Object.values(state.databases).sort((a, b) => a.createdAt - b.createdAt)
  for (const database of databases) {
    const pages = database.rows
      .map((id) => state.pages[id])
      .filter((p): p is Page => Boolean(p) && !p.trashed)
    sources.push({
      id: database.id,
      name: database.name || 'Untitled',
      pages,
      mapping: inferMapping(database),
      database,
    })
  }

  // Loose pages become their own region, so a workspace with no databases at
  // all still grows an island rather than an empty sea.
  const loose = state.pageOrder
    .map((id) => state.pages[id])
    .filter((p): p is Page => Boolean(p) && !p.trashed && !p.databaseId)
  if (loose.length > 0) {
    sources.push({ id: LOOSE_PAGES_REGION, name: 'The commons', pages: loose, mapping: {} })
  }

  return sources
}

interface PlantRecord {
  pageId: string
  angle: number
  due: number
  jitter: number
  species: number
  stage: number
  scale: number
  regionIndex: number
  entityId: number
}

function plantFor(
  page: Page,
  source: Source,
  regionIndex: number,
  angleStart: number,
  angleEnd: number,
): PlantRecord | null {
  const seed = hashString(page.id)

  // Spread plants across the wedge deterministically. Using the page id rather
  // than an index means a plant does not jump sideways when a sibling above it
  // is deleted.
  const across = ((seed >>> 8) & 0xffff) / 0x10000
  const angle = angleStart + across * (angleEnd - angleStart)
  const jitter = ((seed >>> 3) & 0xff) / 0x100

  return {
    pageId: page.id,
    angle,
    due: dueOf(page, source.mapping),
    jitter,
    species: speciesOf(page, source.mapping, seed),
    stage: stageOf(page, source.database, source.mapping),
    scale: scaleOf(page, source.mapping),
    regionIndex,
    entityId: 0, // assigned during packing, so ids are dense
  }
}

function dueOf(page: Page, mapping: IslandMapping): number {
  if (!mapping.dueProperty) return NO_DUE_DATE
  const ms = dateToMillis(page.properties?.[mapping.dueProperty])
  return ms === null ? NO_DUE_DATE : ms
}

/**
 * Growth stage from the row status.
 *
 * Status *groups* rather than option names, because the names are the user's -
 * a Placement Prep board might call the last column "Offer" and a DSA tracker
 * might call it "Mastered", and the island has to understand both without
 * knowing either.
 */
function stageOf(
  page: Page,
  database: Database | undefined,
  mapping: IslandMapping,
): number {
  const { statusProperty } = mapping
  if (!statusProperty) return STAGE.seed

  const property = database?.properties.find((p) => p.id === statusProperty)
  const raw = page.properties?.[statusProperty]

  if (property?.type === 'checkbox') {
    return readBoolean(raw) ? STAGE.lantern : STAGE.seed
  }

  const option = property?.options?.find((o) => o.id === raw || o.name === raw)
  switch (option?.group) {
    case 'complete': return STAGE.lantern
    case 'inProgress': return STAGE.sapling
    default: return STAGE.seed
  }
}

/**
 * Is this page's task complete?
 *
 * The single reading of "done" in the product. The Harvest keepsake uses it
 * too, so a season summary can never disagree with the lanterns burning on the
 * hill - two implementations of this would drift the first time someone added
 * a status group.
 */
export function isPageComplete(state: WorkspaceState, pageId: string): boolean {
  const page = state.pages[pageId]
  if (!page || page.trashed || !page.databaseId) return false
  const database = state.databases[page.databaseId]
  if (!database) return false
  return stageOf(page, database, inferMapping(database)) === STAGE.lantern
}

/**
 * The isle at a glance, for the home page.
 *
 * Everything here is counted from the workspace against a supplied clock, so
 * the home page can be *dynamic* without owning any state of its own: what is
 * due today, what is bobbing in the shallows, what is growing, what is lit. A
 * page that stored these would drift from the isle the first time someone
 * edited a row while it was showing.
 */
export interface IslandDigest {
  /** Tasks whose due date is today, by the local calendar. */
  dueToday: number
  /** Due before today and unfinished: in the shallows, waiting to be lifted. */
  inShallows: number
  /** Unfinished and due after today, somewhere up the slope. */
  growing: number
  /** Unfinished with no date at all: the meadow. */
  meadow: number
  lanterns: number
  /** The soonest unfinished due date, or null. */
  nextDue: number | null
  /** How many databases have become regions. */
  regions: number
}

export function islandDigest(state: WorkspaceState, now: number): IslandDigest {
  const digest: IslandDigest = {
    dueToday: 0, inShallows: 0, growing: 0, meadow: 0, lanterns: 0, nextDue: null, regions: 0,
  }
  const today = new Date(now)
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const dayEnd = dayStart + MS_PER_DAY

  for (const database of Object.values(state.databases)) {
    if (database.rows.length > 0) digest.regions++
  }

  for (const id in state.pages) {
    const page = state.pages[id]
    if (page.trashed || !page.databaseId) continue
    const database = state.databases[page.databaseId]
    if (!database) continue

    if (isPageComplete(state, id)) {
      digest.lanterns++
      continue
    }

    const mapping = inferMapping(database)
    const due = dueOf(page, mapping)
    if (due === NO_DUE_DATE) {
      digest.meadow++
      continue
    }
    // Exclusive buckets. A task due today sits *at* the waterline - Section 4
    // says so directly - and by the afternoon its midnight anchor is already
    // behind the clock, so the raw overdue test would file it in the shallows.
    // On the home page "due today" and "in the shallows" must not both count
    // the same task, or the numbers stop adding up to the isle.
    if (due >= dayStart && due < dayEnd) digest.dueToday++
    else if (isBeachcombable(due, now)) digest.inShallows++
    else digest.growing++
    if (digest.nextDue === null || due < digest.nextDue) digest.nextDue = due
  }

  return digest
}

/**
 * How many lanterns are burning.
 *
 * Counted from the workspace rather than read off a stored counter. The home
 * page used to show `meta.lanternsLit`, which only the Keeper's tend ever
 * incremented - so three lanterns could burn on the hill while the page said
 * zero. Section 2 is the rule: if the island can derive it, nothing else may
 * store it.
 */
export function countLanterns(state: WorkspaceState): number {
  let count = 0
  for (const id in state.pages) {
    if (isPageComplete(state, id)) count++
  }
  return count
}

function speciesOf(page: Page, mapping: IslandMapping, seed: number): number {
  if (mapping.speciesProperty) {
    const raw = page.properties?.[mapping.speciesProperty]
    const first = readStringArray(raw)[0]
    if (first) return hashString(first) % SPECIES_COUNT
  }
  // No category to go on: give it a stable species from its own id, so the
  // meadow is varied rather than a monoculture.
  return seed % SPECIES_COUNT
}

export const SPECIES_COUNT = 6

/**
 * Plant size from the estimate property.
 *
 * Deliberately compressive. A task estimated at eight hours should look
 * meaningfully bigger than a ten-minute one, but not eight times bigger, or a
 * single large task swamps the region it lives in.
 */
function scaleOf(page: Page, mapping: IslandMapping): number {
  if (!mapping.scaleProperty) return 1
  const n = readNumber(page.properties?.[mapping.scaleProperty])
  if (n === null || n <= 0) return 1
  return Math.min(2.2, 0.7 + Math.log10(1 + n) * 0.55)
}

// --- packing ---------------------------------------------------------------

function pack(regions: RegionInfo[], records: PlantRecord[], state: WorkspaceState): IslandSnapshot {
  const count = records.length
  const snapshot: IslandSnapshot = {
    regions,
    count,
    paths: [],
    angle: new Float32Array(count),
    due: new Float32Array(count),
    jitter: new Float32Array(count),
    species: new Uint8Array(count),
    stage: new Uint8Array(count),
    scale: new Float32Array(count),
    regionIndex: new Uint8Array(count),
    entityId: new Uint32Array(count),
    ids: new Array<string>(count),
    revision: 0,
  }

  let revision = 0x811c9dc5
  for (let i = 0; i < count; i++) {
    const r = records[i]
    // Entity ids are dense and one-based. Zero is reserved so the picking
    // buffer can use it to mean "nothing here", which is most of the screen.
    const entityId = i + 1

    snapshot.angle[i] = r.angle
    snapshot.due[i] = r.due
    snapshot.jitter[i] = r.jitter
    snapshot.species[i] = r.species
    snapshot.stage[i] = r.stage
    snapshot.scale[i] = r.scale
    snapshot.regionIndex[i] = r.regionIndex
    snapshot.entityId[i] = entityId
    snapshot.ids[i] = r.pageId

    revision = mixRevision(revision, hashString(r.pageId))
    revision = mixRevision(revision, r.stage * 31 + r.species)
    revision = mixRevision(revision, Math.round(r.due / 1000))
    revision = mixRevision(revision, Math.round(r.scale * 1000))
  }

  // Footpaths, after the index map exists.
  //
  // Deliberately derived here rather than sent as page ids: the renderer wants
  // instance indices so it can read both endpoints straight out of the arrays,
  // and a link whose other end is not on the island is simply not a path.
  const indexOf = new Map<string, number>()
  for (let i = 0; i < count; i++) indexOf.set(snapshot.ids[i], i)

  const newest = latestEdit(state)
  for (const [a, b] of collectLinks(state)) {
    const from = indexOf.get(a)
    const to = indexOf.get(b)
    if (from === undefined || to === undefined) continue
    const touched = Math.max(state.pages[a]?.updatedAt ?? 0, state.pages[b]?.updatedAt ?? 0)
    const ageDays = (newest - touched) / MS_PER_DAY
    const traffic = Math.max(0, Math.min(1, 1 - ageDays / TRAFFIC_WINDOW_DAYS))
    snapshot.paths.push({ from, to, traffic })
    revision = mixRevision(revision, from * 7919 + to)
  }

  snapshot.revision = revision >>> 0
  return snapshot
}

/**
 * The most recent edit anywhere, used as the reference for path age.
 *
 * Relative to the workspace rather than to the wall clock, so `derive` stays
 * pure - and so an island reopened after three weeks away shows the paths that
 * were busy *then*, rather than fading every one of them to nothing.
 */
function latestEdit(state: WorkspaceState): number {
  let newest = 0
  for (const page of Object.values(state.pages)) {
    if (page.updatedAt > newest) newest = page.updatedAt
  }
  return newest
}

function mixRevision(hash: number, value: number): number {
  let h = (hash ^ value) >>> 0
  h = Math.imul(h, 0x01000193)
  return h >>> 0
}

// --- reading the island ----------------------------------------------------

/**
 * Normalised elevation for a due date: 1 at the misty peak, 0 at the waterline,
 * negative in the shallows.
 *
 * Linear in time remaining, which is the whole mechanic - urgency is height,
 * and height is read at a glance rather than counted. Overdue work is allowed
 * to go negative but is floored, because Section 3.3 says an overdue task bobs
 * in the surf and is retrieved, never lost. Three weeks late and three months
 * late sit in the same shallows.
 */
export function elevationFor(dueMillis: number, now: number, horizonDays = ELEVATION_HORIZON_DAYS): number {
  if (dueMillis === NO_DUE_DATE) return MEADOW_LEVEL
  const daysLeft = (dueMillis - now) / MS_PER_DAY
  const t = daysLeft / horizonDays
  return Math.max(OVERDUE_FLOOR, Math.min(1, t))
}

/** Where the flat inland meadow sits on the slope. Off the gradient entirely. */
export const MEADOW_LEVEL = 0.34

/** How far into the shallows an overdue task is allowed to drift. */
export const OVERDUE_FLOOR = -0.18

/** True when a task has slipped past its date and is bobbing in the surf. */
export function isBeachcombable(dueMillis: number, now: number): boolean {
  return dueMillis !== NO_DUE_DATE && dueMillis < now
}
