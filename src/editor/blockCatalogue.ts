import type { BlockType } from '@/state/blocks'

/**
 * One description of every block type, used by three things at once: the slash
 * menu, the Markdown shortcuts, and the renderer. Keeping them in one table is
 * what stops the menu and the shortcuts drifting apart, which is the usual way
 * these end up disagreeing about what `> ` produces.
 */
export interface BlockSpec {
  type: BlockType
  label: string
  hint: string
  /** Glyph for the slash menu. Text, not an icon font - this ships offline. */
  glyph: string
  /** Markdown prefix that converts a paragraph into this type, if any. */
  markdown?: string
  /** Extra words the slash menu will match on. */
  keywords: string[]
  group: 'text' | 'list' | 'media'
}

export const BLOCK_SPECS: BlockSpec[] = [
  { type: 'paragraph', label: 'Text', hint: 'Plain paragraph', glyph: '¶', keywords: ['plain', 'body', 'p'], group: 'text' },
  { type: 'heading1', label: 'Heading 1', hint: 'Large section heading', glyph: 'H1', markdown: '# ', keywords: ['title', 'h1', 'big'], group: 'text' },
  { type: 'heading2', label: 'Heading 2', hint: 'Medium section heading', glyph: 'H2', markdown: '## ', keywords: ['subtitle', 'h2'], group: 'text' },
  { type: 'heading3', label: 'Heading 3', hint: 'Small section heading', glyph: 'H3', markdown: '### ', keywords: ['h3', 'minor'], group: 'text' },
  { type: 'bulleted', label: 'Bulleted list', hint: 'A simple bulleted list', glyph: '•', markdown: '- ', keywords: ['bullet', 'unordered', 'ul'], group: 'list' },
  { type: 'numbered', label: 'Numbered list', hint: 'A list that counts', glyph: '1.', markdown: '1. ', keywords: ['ordered', 'ol', 'number'], group: 'list' },
  { type: 'todo', label: 'To-do', hint: 'Track a task with a checkbox', glyph: '☐', markdown: '[] ', keywords: ['task', 'checkbox', 'check'], group: 'list' },
  { type: 'toggle', label: 'Toggle list', hint: 'Collapsible content', glyph: '▸', markdown: '> ', keywords: ['collapse', 'fold', 'details'], group: 'list' },
  { type: 'quote', label: 'Quote', hint: 'Set text apart', glyph: '❝', markdown: '" ', keywords: ['blockquote', 'cite'], group: 'text' },
  { type: 'callout', label: 'Callout', hint: 'Make it stand out', glyph: '◆', markdown: '! ', keywords: ['note', 'aside', 'info'], group: 'text' },
  { type: 'code', label: 'Code', hint: 'Monospaced block', glyph: '{ }', markdown: '```', keywords: ['snippet', 'pre', 'monospace'], group: 'media' },
  { type: 'divider', label: 'Divider', hint: 'A horizontal rule', glyph: '—', markdown: '---', keywords: ['hr', 'rule', 'separator', 'line'], group: 'media' },
]

const BY_TYPE = new Map(BLOCK_SPECS.map((s) => [s.type, s]))

export function specFor(type: BlockType): BlockSpec {
  return BY_TYPE.get(type) ?? BLOCK_SPECS[0]
}

/**
 * Match a Markdown prefix at the start of a block.
 *
 * Longest prefix first, so `## ` is not swallowed by `# `. Returns the type and
 * how many characters to strip.
 */
export function matchMarkdown(text: string): { type: BlockType; consumed: number } | null {
  const candidates = BLOCK_SPECS
    .filter((s) => s.markdown)
    .sort((a, b) => b.markdown!.length - a.markdown!.length)
  for (const spec of candidates) {
    if (text.startsWith(spec.markdown!)) {
      return { type: spec.type, consumed: spec.markdown!.length }
    }
  }
  return null
}

/**
 * Fuzzy subsequence match, the way a command palette should behave: "h1"
 * matches "Heading 1", "bl" matches "Bulleted list". Scored so that matches
 * earlier in the label and in tighter runs rank first.
 */
export function searchBlocks(query: string): BlockSpec[] {
  const q = query.trim().toLowerCase()
  if (!q) return BLOCK_SPECS

  const scored: Array<{ spec: BlockSpec; score: number }> = []
  for (const spec of BLOCK_SPECS) {
    const haystacks = [spec.label.toLowerCase(), spec.type.toLowerCase(), ...spec.keywords]
    let best = -1
    for (const hay of haystacks) {
      const score = subsequenceScore(hay, q)
      if (score > best) best = score
    }
    if (best >= 0) scored.push({ spec, score: best })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.spec)
}

/** Returns -1 for no match; higher is better. */
function subsequenceScore(haystack: string, needle: string): number {
  let hi = 0
  let score = 0
  let streak = 0
  for (const char of needle) {
    const found = haystack.indexOf(char, hi)
    if (found === -1) return -1
    streak = found === hi ? streak + 1 : 0
    // Reward contiguous runs and matches near the start.
    score += 10 + streak * 6 - Math.min(found, 12)
    hi = found + 1
  }
  if (haystack.startsWith(needle)) score += 40
  return score
}
