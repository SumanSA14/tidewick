#!/usr/bin/env node
/**
 * Validate every WGSL shader in the project with naga, the same front-end wgpu
 * itself uses.
 *
 * This exists because of a very specific failure mode. WGSL compile errors only
 * surface at pipeline creation, on a machine that actually has a WebGPU
 * adapter - and plenty do not, including CI, headless browsers, and (as it
 * happens) the environment this project was developed in. Without an offline
 * check, a shader typo is invisible until someone with the right hardware opens
 * the app, and the code silently takes the CPU fallback in the meantime, which
 * looks exactly like everything working.
 *
 * Usage: node tools/checkShaders.mjs
 * Requires: cargo install naga-cli
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = join(ROOT, 'src')

/** Pull the contents of every `/* wgsl *\/` tagged template literal. */
function extractShaders(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  const re = /\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`/g
  let m
  let n = 0
  while ((m = re.exec(text)) !== null) {
    out.push({ name: `${relative(ROOT, file)}#${n++}`, source: m[1] })
  }
  return out
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.endsWith('.ts')) acc.push(full)
    else if (entry.name.endsWith('.wgsl')) acc.push(full)
  }
  return acc
}

const shaders = []
for (const file of walk(SRC)) {
  if (file.endsWith('.wgsl')) {
    shaders.push({ name: relative(ROOT, file), source: readFileSync(file, 'utf8') })
  } else {
    shaders.push(...extractShaders(file))
  }
}

if (shaders.length === 0) {
  console.log('No WGSL found.')
  process.exit(0)
}

let naga = 'naga'
try {
  execFileSync(naga, ['--version'], { stdio: 'ignore' })
} catch {
  console.error('naga not found on PATH. Install it with:  cargo install naga-cli')
  console.error('Skipping shader validation (exit 0 so this does not block a machine without Rust).')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'tidewick-wgsl-'))
let failures = 0

for (const shader of shaders) {
  const safe = shader.name.replace(/[^a-zA-Z0-9]/g, '_') + '.wgsl'
  const path = join(scratch, safe)
  writeFileSync(path, shader.source, 'utf8')
  try {
    // `naga <file>` parses and validates. There is no `validate` subcommand;
    // --validate is a bitmask flag and takes a value.
    execFileSync(naga, [path], { stdio: 'pipe' })
    console.log(`  ok   ${shader.name}`)
  } catch (err) {
    failures++
    console.error(`  FAIL ${shader.name}`)
    const detail = (err.stderr?.toString() || err.stdout?.toString() || err.message).trimEnd()
    console.error(detail.split('\n').map((l) => `       ${l}`).join('\n'))
  }
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\n${shaders.length - failures}/${shaders.length} shaders valid.`)
process.exit(failures > 0 ? 1 : 0)
