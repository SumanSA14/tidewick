/**
 * Stable hashing.
 *
 * The island's shape is a pure function of the workspace, which means the seed
 * must be derived deterministically and must not drift between sessions,
 * platforms or engine versions. FNV-1a is used rather than anything from the
 * host because we need the exact same number on every target, forever.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a over a UTF-16 string, returned as an unsigned 32-bit integer. */
export function hashString(input: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff
    hash = Math.imul(hash, FNV_PRIME)
    hash ^= input.charCodeAt(i) >>> 8
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** Combine hashes order-dependently. */
export function mixHash(a: number, b: number): number {
  let h = (a ^ b) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * The terrain seed for a workspace.
 *
 * Deliberately depends only on the workspace id and not on its contents: the
 * island's underlying landmass must stay recognisable as you work, while the
 * regions and plants on it change. Content-derived seeds would reshape the
 * whole world every time you typed.
 */
export function terrainSeed(workspaceId: string): number {
  return hashString(`tidewick:terrain:${workspaceId}`)
}
