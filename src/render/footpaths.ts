import {
  LineSegments, BufferGeometry, BufferAttribute, Color,
} from 'three'
import { LineBasicNodeMaterial } from 'three/webgpu'
import { sampleProfile, type RadialProfile } from './terrain/profile'
import { elevationFor, OVERDUE_FLOOR, type IslandSnapshot } from '@/island/derive'

/**
 * Footpaths: relations, walked into the ground.
 *
 * Unlike the plants, these are built on the CPU and rebuilt when the island
 * changes. That is the right trade here and the opposite of the choice made for
 * plants, for a specific reason: a path is a *curve between two moving points*,
 * so placing it in a vertex shader would mean every vertex re-deriving both
 * endpoints, and there is no per-instance slot to put the second one in.
 *
 * Paths also change far less often than the clock ticks. A plant drifts
 * continuously; a link is created once and then sits there. Rebuilding on
 * snapshot change rather than per frame is therefore cheap, and the paths are
 * refreshed on the same slow timer that re-derives the world.
 */

export interface Footpaths {
  line: LineSegments
  rebuild(snapshot: IslandSnapshot, profile: RadialProfile, now: number): void
  setTint(colour: Color): void
  dispose(): void
}

/** Points along each path. More is smoother; each costs two floats. */
const SEGMENTS = 14
/** How far a path bows above the straight line, as a fraction of its length. */
const ARC_HEIGHT = 0.10
/** Paths float this far above the ground so they are not z-fighting terraces. */
const HOVER = 0.35

export function createFootpaths(): Footpaths {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(0), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(0), 3))

  const material = new LineBasicNodeMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })
  // LineSegments, not Line. The buffer is written as independent vertex
  // *pairs*, and a Line strip joins every vertex to the next - which drew each
  // segment twice and, worse, ran a stray connector from the end of one path
  // to the start of the next, across the island between unrelated plants.
  const line = new LineSegments(geometry, material)
  line.name = 'footpaths'
  line.frustumCulled = false

  let tint = new Color(0xd9c9a8)

  return {
    line,

    rebuild(snapshot, profile, now) {
      // Two vertices per segment, so one draw call covers every path on the
      // island and no path is joined to its neighbour.
      const segmentCount = snapshot.paths.length * SEGMENTS
      const positions = new Float32Array(segmentCount * 2 * 3)
      const colours = new Float32Array(segmentCount * 2 * 3)

      let at = 0
      for (const path of snapshot.paths) {
        const a = plantPoint(snapshot, profile, path.from, now)
        const b = plantPoint(snapshot, profile, path.to, now)
        if (!a || !b) continue

        const distance = Math.hypot(b.x - a.x, b.z - a.z)
        const lift = distance * ARC_HEIGHT

        // Foot traffic proportional to recent cross-linked activity: a busy
        // path is bright and a forgotten one fades toward the grass. It never
        // disappears - the link is still real.
        const strength = 0.25 + path.traffic * 0.75

        let previous = pointOnArc(a, b, 0, lift, profile)
        for (let s = 1; s <= SEGMENTS; s++) {
          const current = pointOnArc(a, b, s / SEGMENTS, lift, profile)
          positions[at * 3] = previous.x
          positions[at * 3 + 1] = previous.y
          positions[at * 3 + 2] = previous.z
          colours[at * 3] = tint.r * strength
          colours[at * 3 + 1] = tint.g * strength
          colours[at * 3 + 2] = tint.b * strength
          at++

          positions[at * 3] = current.x
          positions[at * 3 + 1] = current.y
          positions[at * 3 + 2] = current.z
          colours[at * 3] = tint.r * strength
          colours[at * 3 + 1] = tint.g * strength
          colours[at * 3 + 2] = tint.b * strength
          at++

          previous = current
        }
      }

      geometry.setAttribute('position', new BufferAttribute(positions.subarray(0, at * 3), 3))
      geometry.setAttribute('color', new BufferAttribute(colours.subarray(0, at * 3), 3))
      geometry.computeBoundingSphere()
      line.visible = at > 0
    },

    setTint(colour: Color) {
      tint = colour.clone()
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

interface Point { x: number; y: number; z: number }

/** Where a plant currently stands, matching the shader's placement exactly. */
function plantPoint(
  snapshot: IslandSnapshot,
  profile: RadialProfile,
  index: number,
  now: number,
): Point | null {
  if (index < 0 || index >= snapshot.count) return null
  const level = elevationFor(snapshot.due[index], now)
  const sampled = sampleProfile(profile, snapshot.angle[index], Math.max(0, level))
  const jitter = snapshot.jitter[index]
  const angle = snapshot.angle[index] + (jitter - 0.5) * 0.16
  const radius = sampled.radius * (1 - jitter * 0.10)
  const submerged = Math.max(0, Math.min(1, -level / -OVERDUE_FLOOR))
  const y = sampled.height * (1 - submerged) + -1.1 * submerged
  return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius }
}

/**
 * A point along the path.
 *
 * The ground height is re-sampled at every step rather than interpolated
 * between the endpoints, so a path drapes over the terraces in between instead
 * of tunnelling through a ridge that happens to sit on the straight line.
 */
function pointOnArc(
  a: Point,
  b: Point,
  t: number,
  lift: number,
  profile: RadialProfile,
): Point {
  const x = a.x + (b.x - a.x) * t
  const z = a.z + (b.z - a.z) * t

  const radius = Math.hypot(x, z)
  const angle = Math.atan2(z, x)
  const ground = groundAt(profile, angle, radius)

  // A gentle bow, so crossing paths are distinguishable rather than coplanar.
  const arc = Math.sin(t * Math.PI) * lift
  const straight = a.y + (b.y - a.y) * t
  return { x, y: Math.max(ground, straight) + HOVER + arc, z }
}

/**
 * Ground height at a world position, by searching the profile for the level
 * whose radius matches. The profile is indexed by elevation, not by radius, so
 * this walks it - 48 steps against a 64x48 table, which is nothing next to
 * sampling the heightfield itself.
 */
function groundAt(profile: RadialProfile, angle: number, radius: number): number {
  let best = 0
  for (let l = 0; l < profile.levels; l++) {
    const sampled = sampleProfile(profile, angle, l / (profile.levels - 1))
    if (sampled.radius >= radius) best = sampled.height
  }
  return best
}
