import { SCHEMA_VERSION, type WorkspaceState } from './types'
import type { Page, Mark } from './blocks'
import { formatDate, formatNumber } from '@/db/PropertyCell'

/**
 * Import and export.
 *
 * Section 6.5 asks for both, and for a local-first product they are not a
 * convenience feature - they are the user's only guarantee that the data is
 * theirs. So the JSON export is the *entire* workspace tree, unabridged, with
 * the schema version stamped on it, and import runs it through the same
 * validation the disk loader uses. Nothing is transformed on the way out, which
 * means an export re-imported is byte-for-byte the workspace it came from.
 *
 * Markdown export is lossy on purpose and says so: it is for taking a page
 * somewhere else, not for round-tripping. Marks survive; block nesting becomes
 * indentation; property values become a small table at the top.
 */

export interface WorkspaceExport {
  format: 'tidewick-workspace'
  version: number
  exportedAt: number
  workspace: WorkspaceState
}

export function exportWorkspace(state: WorkspaceState, now = Date.now()): string {
  const bundle: WorkspaceExport = {
    format: 'tidewick-workspace',
    version: SCHEMA_VERSION,
    exportedAt: now,
    workspace: state,
  }
  return JSON.stringify(bundle, null, 2)
}

export type ImportResult =
  | { ok: true; workspace: WorkspaceState }
  | { ok: false; reason: string }

/**
 * Parse an export back into a workspace.
 *
 * Refuses rather than guesses: a file from a newer build, or one that is not
 * ours, comes back with a reason instead of a half-loaded tree. A rejected
 * import loses nothing; a corrupted one loses everything.
 */
export function importWorkspace(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'That file is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'That file is not a Tidewick export.' }

  const bundle = parsed as Partial<WorkspaceExport>
  if (bundle.format !== 'tidewick-workspace') return { ok: false, reason: 'That file is not a Tidewick export.' }
  if (typeof bundle.version !== 'number') return { ok: false, reason: 'The export has no schema version.' }
  if (bundle.version > SCHEMA_VERSION) {
    return { ok: false, reason: `This export was written by a newer Tidewick (schema ${bundle.version}); this build reads up to ${SCHEMA_VERSION}.` }
  }

  const ws = bundle.workspace
  if (!ws || typeof ws !== 'object') return { ok: false, reason: 'The export has no workspace in it.' }
  if (!ws.meta || typeof ws.meta.id !== 'string') return { ok: false, reason: 'The workspace has no id.' }

  // Older exports: fill in what later schemas added, the same way the disk
  // loader does. Kept deliberately small - the disk migration is the source
  // of truth and this mirrors its shape.
  const workspace: WorkspaceState = {
    meta: {
      ...ws.meta,
      sunlight: ws.meta.sunlight ?? 0,
      warmth: ws.meta.warmth ?? 1,
      seasonStartedAt: ws.meta.seasonStartedAt ?? ws.meta.createdAt ?? Date.now(),
      seasonsHarvested: ws.meta.seasonsHarvested ?? 0,
      lanternsLit: ws.meta.lanternsLit ?? 0,
      focusMinutes: ws.meta.focusMinutes ?? 0,
      seasonIndex: ws.meta.seasonIndex ?? 0,
    },
    pages: ws.pages ?? {},
    blocks: ws.blocks ?? {},
    databases: ws.databases ?? {},
    pageOrder: ws.pageOrder ?? [],
  }
  return { ok: true, workspace }
}

/**
 * A page as Markdown.
 *
 * Headings, lists, to-dos, quotes, callouts, code and dividers map directly;
 * a callout becomes a blockquote with a leading marker because Markdown has no
 * callout. Rows carry their properties as a definition list at the top.
 */
export function pageToMarkdown(state: WorkspaceState, pageId: string): string {
  const page = state.pages[pageId]
  if (!page) return ''
  const lines: string[] = [`# ${page.title || 'Untitled'}`, '']

  if (page.databaseId && page.properties) {
    const database = state.databases[page.databaseId]
    if (database) {
      for (const property of database.properties) {
        if (property.type === 'title') continue
        const value = renderProperty(page, property.id, database)
        if (value) lines.push(`- **${property.name}:** ${value}`)
      }
      if (lines.length > 2) lines.push('')
    }
  }

  let numbered = 0
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = state.blocks[id]
      if (!block) continue
      const indent = '  '.repeat(depth)
      const text = inlineMarkdown(block.text, block.marks)
      switch (block.type) {
        case 'heading1': lines.push(`${indent}# ${text}`); break
        case 'heading2': lines.push(`${indent}## ${text}`); break
        case 'heading3': lines.push(`${indent}### ${text}`); break
        case 'bulleted': lines.push(`${indent}- ${text}`); break
        case 'numbered': numbered++; lines.push(`${indent}${numbered}. ${text}`); break
        case 'todo': lines.push(`${indent}- [${block.checked ? 'x' : ' '}] ${text}`); break
        case 'toggle': lines.push(`${indent}- ${text}`); break
        case 'quote': lines.push(`${indent}> ${text}`); break
        case 'callout': lines.push(`${indent}> **Note:** ${text}`); break
        case 'code':
          lines.push(`${indent}\`\`\`${block.language ?? ''}`)
          lines.push(...block.text.split('\n').map((l) => indent + l))
          lines.push(`${indent}\`\`\``)
          break
        case 'divider': lines.push(`${indent}---`); break
        default:
          if (text || block.type !== 'paragraph') lines.push(`${indent}${text}`)
          else lines.push('')
      }
      if (block.type !== 'numbered') numbered = 0
      if (block.children.length) walk(block.children, depth + 1)
    }
  }
  walk(page.children, 0)

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderProperty(page: Page, propertyId: string, database: WorkspaceState['databases'][string]): string {
  const property = database.properties.find((p) => p.id === propertyId)
  const raw = page.properties?.[propertyId]
  if (!property || raw === undefined || raw === null || raw === '') return ''
  switch (property.type) {
    case 'date': return formatDate(raw, property)
    case 'number': return formatNumber(raw, property)
    case 'checkbox': return raw === true || raw === 'true' ? 'yes' : 'no'
    case 'select':
    case 'status':
    case 'multiSelect': {
      const values = Array.isArray(raw) ? raw : [raw]
      return values
        .map((v) => property.options?.find((o) => o.id === v || o.name === v)?.name ?? String(v))
        .join(', ')
    }
    default:
      return Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'object' ? '' : String(raw)
  }
}

/** Apply bold/italic/code/strike marks as Markdown, innermost first. */
function inlineMarkdown(text: string, marks: Mark[]): string {
  if (!marks || marks.length === 0) return text
  // Insert wrappers from the end so earlier offsets stay valid.
  const edits: Array<{ at: number; str: string }> = []
  for (const mark of marks) {
    const wrap = mark.type === 'bold' ? '**' : mark.type === 'italic' ? '_' : mark.type === 'code' ? '`' : mark.type === 'strike' ? '~~' : ''
    if (!wrap) continue
    edits.push({ at: mark.start, str: wrap }, { at: mark.end, str: wrap })
  }
  edits.sort((a, b) => b.at - a.at)
  let out = text
  for (const edit of edits) out = out.slice(0, edit.at) + edit.str + out.slice(edit.at)
  return out
}

/** Hand the browser a file. Inert for viewers of a hosted artifact; fine in the app. */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A safe filename from an isle name. */
export function exportFilename(isleName: string, ext: string, now = new Date()): string {
  const base = (isleName || 'tidewick').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tidewick'
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `${base}-${stamp}.${ext}`
}
