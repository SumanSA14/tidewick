#!/usr/bin/env node
/**
 * Section 16: "zero hard-coded personal names, proven by grep."
 *
 * This is that grep, run over everything that ships: source, packs, styles,
 * the Tauri shell and the manifest. It checks two things.
 *
 *   1. No default is ever a person. `createWorkspace` must leave `isleName` and
 *      `keeper.name` empty, so every name in the running app was typed by the
 *      person using it. Checked structurally rather than by pattern: a default
 *      of "Wren" is a bug even though "Wren" is also a bird.
 *
 *   2. No name from the blocklist appears in shipped code. The list is the
 *      names that have appeared in this project's fixtures, test data and
 *      sessions - the ones actually at risk of leaking - plus the usual
 *      placeholder people. Test files are excluded: fixtures are allowed to
 *      name a person, and they do.
 *
 * Exits non-zero on any hit. Wired into `pnpm check`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOTS = ['src', 'public', 'src-tauri/src', 'src-tauri/tauri.conf.json', 'index.html']
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.json', '.html', '.rs', '.webmanifest', '.js', '.mjs'])

// Whole-word, case-insensitive. Keep this honest: add a name when it shows up
// in a fixture, not preemptively.
// Not "bob", "alice" and friends: `bob` is the Keeper's vertical bob and a
// word-list of common first names flags half the English language. The first
// run of this script produced thirteen hits, all of them the animation field.
//
// The committed list holds only placeholders. The names of the people who
// actually work on this project - the ones most at risk of leaking - live in
// an untracked `.names.local` beside package.json, one per line, so the check
// guards them on their machines without publishing them in the check itself.
const BLOCKLIST = ['wren', 'john doe', 'jane doe', ...localNames()]

function localNames() {
  try {
    return readFileSync('.names.local', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

const problems = []

function walk(path) {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry))
    return
  }
  if (!EXTENSIONS.has(extname(path))) return
  const rel = relative(process.cwd(), path).replace(/\\/g, '/')
  if (/\.test\.(ts|tsx)$/.test(rel) || rel.startsWith('src/test/')) return
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  for (const name of BLOCKLIST) {
    const re = new RegExp(`(^|[^a-z0-9])${name.replace(/ /g, '\\s+')}([^a-z0-9]|$)`, 'i')
    lines.forEach((line, i) => {
      if (re.test(line)) problems.push(`${rel}:${i + 1}: mentions "${name}"`)
    })
  }
}

for (const root of ROOTS) {
  try { walk(root) } catch { /* optional root */ }
}

// Structural check on the defaults.
const types = readFileSync('src/state/types.ts', 'utf8')
const isleDefault = /isleName:\s*'([^']*)'/.exec(types)
const keeperDefault = /name:\s*'([^']*)'/.exec(types.slice(types.indexOf('keeper: {')))
if (!isleDefault || isleDefault[1] !== '') problems.push("src/state/types.ts: createWorkspace must default isleName to ''")
if (!keeperDefault || keeperDefault[1] !== '') problems.push("src/state/types.ts: createWorkspace must default keeper.name to ''")

if (problems.length) {
  console.error(`\n${problems.length} personal-name problem(s):\n`)
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log('No hard-coded personal names in shipped code; defaults are empty.')
