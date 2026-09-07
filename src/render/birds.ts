import {
  InstancedBufferGeometry, InstancedBufferAttribute, BufferGeometry, BufferAttribute,
  Mesh, Sphere, Vector3, Color, DynamicDrawUsage, DoubleSide,
} from 'three'
import { MeshToonNodeMaterial } from 'three/webgpu'
import { attribute, positionLocal, vec3, uniform, mix, Fn, float } from 'three/tsl'
import { makeToonRamp, PROP_RAMP_STOPS } from './materials/toonRamp'
import { mulberry32 } from '@/core/rng'
import { TERRAIN } from '@/core/config'
import type { GroundSampler } from '@/keeper/controller'

/**
 * Birds over the isle.
 *
 * Section 9's flocking workload, on the path that actually runs here. The
 * brief asks for 50k agents with spatial hashing on the GPU; this is the CPU
 * strategy the same section requires every compute workload to declare for
 * WebGL2. `boids.wgsl.ts` carries the compute version, naga-validated and -
 * said plainly - never executed, because no machine in this project has a
 * WebGPU adapter.
 *
 * The drawn count is a few hundred, not thousands: see `TIER_BUDGETS`. The
 * simulation below is written for ten thousand and has been run at that count,
 * but a calm island wants a flock, not a swarm.
 *
 * **Spatial hashing is what makes 10k affordable.** Naive flocking is O(n²);
 * with agents binned into cells the size of the neighbour radius, each one
 * looks at its own cell and the eight around it and stops after a dozen
 * neighbours. At 10k agents that is a few hundred thousand operations per
 * step, which fits inside the CPU budget at a 30 Hz update - and birds do not
 * need 60.
 *
 * The flock is gentle by design. Three rules plus a soft pull toward a wide
 * ring above the island, so the birds circle rather than scatter, and a floor
 * so they never fly through a hill. Nothing here chases anything.
 */

export interface Birds {
  mesh: Mesh
  /** How many agents are flying. */
  readonly count: number
  /** Advance the flock. Call from the fixed step. */
  step(dt: number, ground: GroundSampler | null): void
  /** Dim toward dusk; birds roost at night. */
  setLight(daylight: number): void
  setTint(colour: Color): void
  dispose(): void
}

export const BOID = {
  /** Neighbour radius, and the spatial hash cell size. */
  radius: 9,
  maxNeighbours: 12,
  separation: 1.6,
  alignment: 1.1,
  /**
   * Strong on purpose. The first flock had cohesion at 0.55 and read as a
   * uniform sprinkle of marks over the sea - confetti, not birds. Birds are
   * recognisable by the *group*: a few loose flocks drifting, with empty sky
   * between them.
   */
  cohesion: 1.4,
  /** Spring toward the flock's home, per ring-width of distance. */
  ring: 0.9,
  ringRadius: 95,
  ringHeight: 52,
  ringWidth: 40,
  minSpeed: 7,
  maxSpeed: 16,
  /** Clearance kept above the terrain. */
  floor: 9,
  /** Simulation runs this often; the mesh is only re-uploaded when it does. */
  hz: 30,
  /**
   * Distinct flocks. A single global ring target homogenises everything into
   * an even band - the density test measured it: the coefficient of variation
   * of neighbour counts *fell* from 0.73 to 0.33 as the rules ran. Each flock
   * is pulled toward its own point on the ring, drifting at its own rate, so
   * groups persist with empty sky between them.
   */
  flocks: 5,
} as const

/** x, y, z, vx, vy, vz per agent. */
const STRIDE = 6

export function createBirds(count: number, seed: number): Birds {
  // A bird is a stretched tetrahedron: a body and two swept wings. Four
  // triangles, which at 10k agents is 40k triangles for the whole flock.
  const source = new BufferGeometry()
  // Small. A bird at this distance is a mark, not a model: a wingspan under
  // two units reads as a gull; the first version's 3.2 read as a hang-glider.
  source.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0.9,        // beak
    0, 0.08, -0.5,    // tail
    -0.95, 0.22, -0.15, // left wingtip
    0.95, 0.22, -0.15,  // right wingtip
  ]), 3))
  source.setIndex([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3])
  source.computeVertexNormals()

  const geometry = new InstancedBufferGeometry()
  geometry.index = source.index
  geometry.attributes.position = source.attributes.position
  geometry.attributes.normal = source.attributes.normal
  geometry.instanceCount = count
  geometry.boundingSphere = new Sphere(new Vector3(0, BOID.ringHeight, 0), TERRAIN.worldSize)

  const state = new Float32Array(count * STRIDE)
  const rand = mulberry32(seed ^ 0x27d4eb2f)

  // Each flock's home on the ring: a phase, a drift rate, and its own height.
  const flockPhase = new Float32Array(BOID.flocks)
  const flockRate = new Float32Array(BOID.flocks)
  const flockHeight = new Float32Array(BOID.flocks)
  for (let f = 0; f < BOID.flocks; f++) {
    flockPhase[f] = (f / BOID.flocks) * Math.PI * 2 + rand() * 0.6
    flockRate[f] = 0.035 + rand() * 0.03
    flockHeight[f] = BOID.ringHeight + (rand() - 0.5) * 22
  }

  // Birds spawn *with* their flock. Seeding them evenly around the ring and
  // asking cohesion to sort them out meant every group had to cross the isle
  // to assemble, and most never did.
  for (let i = 0; i < count; i++) {
    const f = i % BOID.flocks
    const a = flockPhase[f] + (rand() - 0.5) * 0.35
    const r = BOID.ringRadius + (rand() - 0.5) * BOID.ringWidth * 0.6
    const at = i * STRIDE
    state[at] = Math.cos(a) * r
    state[at + 1] = flockHeight[f] + (rand() - 0.5) * 10
    state[at + 2] = Math.sin(a) * r
    // Moving along the ring together, with a little scatter.
    const speed = BOID.minSpeed + rand() * (BOID.maxSpeed - BOID.minSpeed) * 0.5
    state[at + 3] = -Math.sin(a) * speed + (rand() - 0.5) * 2
    state[at + 4] = (rand() - 0.5) * 1.5
    state[at + 5] = Math.cos(a) * speed + (rand() - 0.5) * 2
  }

  // Per-instance position and heading are separate attributes so the upload
  // is one contiguous copy of the sim buffer.
  const iPos = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  const iDir = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
  iPos.setUsage(DynamicDrawUsage)
  iDir.setUsage(DynamicDrawUsage)
  geometry.setAttribute('bPos', iPos)
  geometry.setAttribute('bDir', iDir)

  const uLit = uniform(1)
  const uTint = uniform(new Color(0x7a8593))

  const aPos = attribute<'vec3'>('bPos', 'vec3')
  const aDir = attribute<'vec3'>('bDir', 'vec3')

  /**
   * Orient the body along its velocity.
   *
   * A look-at built in the shader from the heading: forward is the velocity,
   * up is world up bent slightly by the turn, right is their cross. Cheaper
   * than uploading a quaternion per bird and exactly as correct for something
   * this small on screen.
   */
  const oriented = Fn(() => {
    const forward = aDir.normalize()
    const worldUp = vec3(0, 1, 0)
    const right = forward.cross(worldUp).normalize()
    const up = right.cross(forward)
    const p = positionLocal
    return aPos.add(right.mul(p.x)).add(up.mul(p.y)).add(forward.mul(p.z))
  })

  const material = new MeshToonNodeMaterial({
    gradientMap: makeToonRamp(PROP_RAMP_STOPS),
    side: DoubleSide,
  })
  material.positionNode = oriented()
  // Dark against the sky by day; at dusk they fade rather than glowing.
  material.colorNode = mix(uTint, uTint.mul(0.45), float(1).sub(uLit)).mul(uLit.mul(0.6).add(0.4))

  const mesh = new Mesh(geometry, material)
  mesh.name = 'birds'
  mesh.frustumCulled = false
  mesh.castShadow = false

  // --- spatial hash ---------------------------------------------------------
  // Rebuilt every step. Cells are keyed on a flat grid over the flight volume;
  // `cellStart` is a prefix sum so the agents in a cell are one contiguous run
  // of `sorted`, which is what keeps the neighbour scan cache-friendly.
  const cellSize = BOID.radius
  const extent = TERRAIN.worldSize * 1.2
  const cellsAcross = Math.ceil((extent * 2) / cellSize)
  const cellsUp = Math.ceil(120 / cellSize)
  const cellCount = cellsAcross * cellsAcross * cellsUp
  const cellStart = new Int32Array(cellCount + 1)
  const sorted = new Int32Array(count)
  const cellOf = new Int32Array(count)

  const cellIndex = (x: number, y: number, z: number): number => {
    const cx = Math.min(cellsAcross - 1, Math.max(0, Math.floor((x + extent) / cellSize)))
    const cz = Math.min(cellsAcross - 1, Math.max(0, Math.floor((z + extent) / cellSize)))
    const cy = Math.min(cellsUp - 1, Math.max(0, Math.floor(y / cellSize)))
    return (cy * cellsAcross + cz) * cellsAcross + cx
  }

  const rebuildHash = () => {
    cellStart.fill(0)
    for (let i = 0; i < count; i++) {
      const at = i * STRIDE
      const c = cellIndex(state[at], state[at + 1], state[at + 2])
      cellOf[i] = c
      cellStart[c + 1]++
    }
    for (let c = 0; c < cellCount; c++) cellStart[c + 1] += cellStart[c]
    // Counting sort into `sorted`, consuming the prefix sums as cursors.
    const cursor = cellStart.slice(0, cellCount)
    for (let i = 0; i < count; i++) sorted[cursor[cellOf[i]]++] = i
  }

  let accumulator = 0
  const stepSeconds = 1 / BOID.hz
  const radiusSq = BOID.radius * BOID.radius
  let lit = 1
  let clock = 0

  const targetX = new Float32Array(BOID.flocks)
  const targetY = new Float32Array(BOID.flocks)
  const targetZ = new Float32Array(BOID.flocks)

  const simulate = (dt: number, ground: GroundSampler | null) => {
    rebuildHash()
    clock += dt
    for (let f = 0; f < BOID.flocks; f++) {
      const a = flockPhase[f] + clock * flockRate[f]
      const r = BOID.ringRadius + Math.sin(clock * 0.11 + f) * BOID.ringWidth * 0.35
      targetX[f] = Math.cos(a) * r
      targetY[f] = flockHeight[f]
      targetZ[f] = Math.sin(a) * r
    }

    for (let i = 0; i < count; i++) {
      const at = i * STRIDE
      const px = state[at]
      const py = state[at + 1]
      const pz = state[at + 2]
      let vx = state[at + 3]
      let vy = state[at + 4]
      let vz = state[at + 5]

      // Neighbours: this cell and the 26 around it, capped.
      let sepX = 0, sepY = 0, sepZ = 0
      let aliX = 0, aliY = 0, aliZ = 0
      let cohX = 0, cohY = 0, cohZ = 0
      let found = 0

      const cx = Math.floor((px + extent) / cellSize)
      const cz = Math.floor((pz + extent) / cellSize)
      const cy = Math.floor(py / cellSize)

      outer:
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= cellsUp) continue
        for (let dz = -1; dz <= 1; dz++) {
          const nz = cz + dz
          if (nz < 0 || nz >= cellsAcross) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            if (nx < 0 || nx >= cellsAcross) continue
            const c = (ny * cellsAcross + nz) * cellsAcross + nx
            for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
              const j = sorted[s]
              if (j === i) continue
              const bt = j * STRIDE
              const ox = state[bt] - px
              const oy = state[bt + 1] - py
              const oz = state[bt + 2] - pz
              const d2 = ox * ox + oy * oy + oz * oz
              if (d2 > radiusSq || d2 < 1e-6) continue
              // Separation falls off with distance; the others do not.
              const inv = 1 / d2
              sepX -= ox * inv; sepY -= oy * inv; sepZ -= oz * inv
              aliX += state[bt + 3]; aliY += state[bt + 4]; aliZ += state[bt + 5]
              cohX += ox; cohY += oy; cohZ += oz
              if (++found >= BOID.maxNeighbours) break outer
            }
          }
        }
      }

      let ax = 0, ay = 0, az = 0
      if (found > 0) {
        const inv = 1 / found
        ax += sepX * BOID.separation
        ay += sepY * BOID.separation
        az += sepZ * BOID.separation
        ax += (aliX * inv - vx) * BOID.alignment * 0.1
        ay += (aliY * inv - vy) * BOID.alignment * 0.1
        az += (aliZ * inv - vz) * BOID.alignment * 0.1
        ax += cohX * inv * BOID.cohesion * 0.1
        ay += cohY * inv * BOID.cohesion * 0.1
        az += cohZ * inv * BOID.cohesion * 0.1
      }

      // Home: a soft pull toward this bird's flock target, which itself drifts
      // around the ring. Soft, so the group breathes around the point rather
      // than collapsing onto it.
      const f = i % BOID.flocks
      const hx = targetX[f] - px
      const hy = targetY[f] - py
      const hz = targetZ[f] - pz
      const hd = Math.hypot(hx, hy, hz) || 1
      // A spring: the further from home, the harder the pull. Clamping this
      // to a constant let a bird that overshot its group keep going - the
      // dispersal test counted a third of the flock a long way out at sea.
      const pull = (hd / BOID.ringWidth) * BOID.ring
      ax += (hx / hd) * pull
      ay += (hy / hd) * pull * 0.7
      az += (hz / hd) * pull
      // And a gentle drift along the ring, so the groups travel.
      const r = Math.hypot(px, pz) || 1
      ax += (-pz / r) * 0.04
      az += (px / r) * 0.04

      // Never through a hill. Birds are the one thing that must read as free,
      // and clipping the summit would break that instantly.
      if (ground) {
        const floor = ground.heightAt(px, pz) + BOID.floor
        if (py < floor) ay += (floor - py) * 0.6
      }

      vx += ax * dt * 4
      vy += ay * dt * 4
      vz += az * dt * 4

      // Clamp speed to a band. Too slow and a bird hangs in the air; too fast
      // and the flock tears itself apart.
      const speed = Math.hypot(vx, vy, vz) || 1
      const clamped = Math.min(BOID.maxSpeed, Math.max(BOID.minSpeed, speed))
      const k = clamped / speed
      vx *= k; vy *= k; vz *= k

      state[at] = px + vx * dt
      state[at + 1] = py + vy * dt
      state[at + 2] = pz + vz * dt
      state[at + 3] = vx
      state[at + 4] = vy
      state[at + 5] = vz
    }

    // Upload.
    const pos = iPos.array as Float32Array
    const dir = iDir.array as Float32Array
    for (let i = 0; i < count; i++) {
      const at = i * STRIDE
      pos[i * 3] = state[at]
      pos[i * 3 + 1] = state[at + 1]
      pos[i * 3 + 2] = state[at + 2]
      dir[i * 3] = state[at + 3]
      dir[i * 3 + 1] = state[at + 4]
      dir[i * 3 + 2] = state[at + 5]
    }
    iPos.needsUpdate = true
    iDir.needsUpdate = true
  }

  // Seed the attributes so the first frame is not a flock at the origin.
  simulate(0, null)

  return {
    mesh,
    count,

    step(dt, ground) {
      // Birds roost after dusk: the flock thins with the light rather than
      // circling a dark sky where nobody can see it.
      mesh.visible = lit > 0.18 && count > 0
      if (!mesh.visible) return
      accumulator += dt
      while (accumulator >= stepSeconds) {
        simulate(stepSeconds, ground)
        accumulator -= stepSeconds
      }
    },

    setLight(daylight) {
      lit = daylight
      uLit.value = Math.max(0.15, daylight)
    },

    setTint(colour) {
      uTint.value.copy(colour)
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
