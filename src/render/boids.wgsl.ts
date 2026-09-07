/**
 * Flocking on the GPU: the compute path for Section 9's 50k agents.
 *
 * **Naga-validated, never executed.** No machine available to this project has
 * a WebGPU adapter, so - exactly as with the erosion and FFT shaders - this has
 * been checked for well-formed WGSL and type-correct bindings and has not been
 * run. `birds.ts` is the path that runs, with the same three rules, the same
 * ring, the same floor and the same spatial hash, so when this does execute
 * the two can be compared cell for cell.
 *
 * Three dispatches per step, which is the standard shape for a hashed flock:
 *
 *   1. `countCells`   - each agent atomically increments its cell's count.
 *   2. `prefixSum`    - a single workgroup scans the counts into cell starts.
 *                       Serial over cells, which is fine: there are a few tens
 *                       of thousands of cells and one of these per step.
 *   3. `scatter`      - each agent claims a slot in its cell (atomic add on the
 *                       cell cursor) and writes its index into the sorted list.
 *   4. `steer`        - each agent scans its 27 neighbouring cells through the
 *                       sorted list, applies the rules, and writes the next
 *                       state to the other half of a ping-pong buffer.
 *
 * The flock homes are computed on the CPU and uploaded per step rather than
 * derived in the shader: they are five vec4s, and keeping one implementation
 * of "where is flock f right now" is worth a 80-byte upload.
 *
 * Positions and velocities are `vec4<f32>` rather than `vec3` because of the
 * WGSL storage-buffer alignment rules: an array of vec3 is padded to 16 bytes
 * per element anyway, and being explicit about it keeps the CPU-side layout
 * from silently disagreeing.
 */

export const BOIDS_WGSL = /* wgsl */ `
struct Params {
  count: u32,
  cellsAcross: u32,
  cellsUp: u32,
  cellCount: u32,
  cellSize: f32,
  extent: f32,
  dt: f32,
  radiusSq: f32,
  separation: f32,
  alignment: f32,
  cohesion: f32,
  ring: f32,
  ringRadius: f32,
  ringHeight: f32,
  ringWidth: f32,
  minSpeed: f32,
  maxSpeed: f32,
  floor: f32,
  maxNeighbours: u32,
  /** Distinct flocks; bird i belongs to flock i % flocks. */
  flocks: u32,
  _pad1: u32,
  _pad2: u32,
};

// Terrain heights for the floor rule, sampled as a flat grid over the isle.
struct Ground {
  size: u32,
  worldSize: f32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> velIn: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> posOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> velOut: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> cellCounts: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> cellStarts: array<u32>;
@group(0) @binding(7) var<storage, read_write> cellCursors: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> sorted: array<u32>;
@group(0) @binding(9) var<uniform> ground: Ground;
@group(0) @binding(10) var<storage, read> heights: array<f32>;
// Each flock's drifting home on the ring, written by the CPU per step - the
// same targets birds.ts computes, so the two paths steer toward the same
// points. xyz is the home; w is unused padding.
@group(0) @binding(11) var<storage, read> flockHomes: array<vec4<f32>>;

fn cellCoord(p: vec3<f32>) -> vec3<i32> {
  let across = i32(params.cellsAcross);
  let up = i32(params.cellsUp);
  let cx = clamp(i32(floor((p.x + params.extent) / params.cellSize)), 0, across - 1);
  let cz = clamp(i32(floor((p.z + params.extent) / params.cellSize)), 0, across - 1);
  let cy = clamp(i32(floor(p.y / params.cellSize)), 0, up - 1);
  return vec3<i32>(cx, cy, cz);
}

fn cellIndex(c: vec3<i32>) -> u32 {
  let across = i32(params.cellsAcross);
  return u32((c.y * across + c.z) * across + c.x);
}

fn groundHeight(x: f32, z: f32) -> f32 {
  let half = ground.worldSize * 0.5;
  let scale = f32(ground.size) / ground.worldSize;
  let gx = i32(floor((x + half) * scale));
  let gz = i32(floor((z + half) * scale));
  let n = i32(ground.size);
  if (gx < 0 || gz < 0 || gx >= n || gz >= n) {
    return -4.0;
  }
  return heights[u32(gz * n + gx)];
}

// --- 1. count -------------------------------------------------------------

@compute @workgroup_size(256)
fn countCells(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let c = cellIndex(cellCoord(posIn[i].xyz));
  atomicAdd(&cellCounts[c], 1u);
}

// --- 2. prefix sum ----------------------------------------------------------
// One workgroup, one thread, a plain serial scan. Tens of thousands of cells
// once a step is not worth a parallel scan's complexity.

@compute @workgroup_size(1)
fn prefixSum() {
  var running = 0u;
  for (var c = 0u; c < params.cellCount; c = c + 1u) {
    cellStarts[c] = running;
    atomicStore(&cellCursors[c], running);
    running = running + atomicLoad(&cellCounts[c]);
  }
  cellStarts[params.cellCount] = running;
}

// --- 3. scatter -------------------------------------------------------------

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let c = cellIndex(cellCoord(posIn[i].xyz));
  let slot = atomicAdd(&cellCursors[c], 1u);
  sorted[slot] = i;
}

// --- 4. steer ---------------------------------------------------------------

@compute @workgroup_size(256)
fn steer(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }

  let p = posIn[i].xyz;
  var v = velIn[i].xyz;

  var sep = vec3<f32>(0.0);
  var ali = vec3<f32>(0.0);
  var coh = vec3<f32>(0.0);
  var found = 0u;

  let home = cellCoord(p);
  let across = i32(params.cellsAcross);
  let up = i32(params.cellsUp);

  for (var dy = -1; dy <= 1; dy = dy + 1) {
    let ny = home.y + dy;
    if (ny < 0 || ny >= up) {
      continue;
    }
    for (var dz = -1; dz <= 1; dz = dz + 1) {
      let nz = home.z + dz;
      if (nz < 0 || nz >= across) {
        continue;
      }
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let nx = home.x + dx;
        if (nx < 0 || nx >= across) {
          continue;
        }
        let c = cellIndex(vec3<i32>(nx, ny, nz));
        let start = cellStarts[c];
        let end = cellStarts[c + 1u];
        for (var s = start; s < end; s = s + 1u) {
          let j = sorted[s];
          if (j == i) {
            continue;
          }
          let o = posIn[j].xyz - p;
          let d2 = dot(o, o);
          if (d2 > params.radiusSq || d2 < 1e-6) {
            continue;
          }
          sep = sep - o / d2;
          ali = ali + velIn[j].xyz;
          coh = coh + o;
          found = found + 1u;
          if (found >= params.maxNeighbours) {
            break;
          }
        }
      }
    }
  }

  var a = vec3<f32>(0.0);
  if (found > 0u) {
    let inv = 1.0 / f32(found);
    a = a + sep * params.separation;
    a = a + (ali * inv - v) * params.alignment * 0.1;
    a = a + coh * inv * params.cohesion * 0.1;
  }

  // Home: a spring toward this bird's flock target, harder the further away,
  // and a gentle drift along the ring so the groups travel. Mirrors birds.ts.
  let nest = flockHomes[i % params.flocks].xyz;
  let toHome = nest - p;
  let hd = max(length(toHome), 1e-3);
  let pull = (hd / params.ringWidth) * params.ring;
  a = a + (toHome / hd) * vec3<f32>(pull, pull * 0.7, pull);
  let r = max(length(p.xz), 1e-3);
  a.x = a.x + (-p.z / r) * 0.04;
  a.z = a.z + (p.x / r) * 0.04;

  // Never through a hill.
  let floorY = groundHeight(p.x, p.z) + params.floor;
  if (p.y < floorY) {
    a.y = a.y + (floorY - p.y) * 0.6;
  }

  v = v + a * params.dt * 4.0;

  let speed = max(length(v), 1e-3);
  let clamped = clamp(speed, params.minSpeed, params.maxSpeed);
  v = v * (clamped / speed);

  posOut[i] = vec4<f32>(p + v * params.dt, 0.0);
  velOut[i] = vec4<f32>(v, 0.0);
}
`
