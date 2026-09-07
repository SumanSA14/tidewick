/**
 * Droplet hydraulic erosion, WGSL compute.
 *
 * One invocation per droplet. The heightmap is `array<atomic<i32>>` in
 * fixed point rather than `array<f32>`, because WGSL has no float atomics -
 * atomicAdd is defined for i32 and u32 only. Every droplet reads and writes the
 * same map, so without atomics the deposits and erosions of concurrent droplets
 * simply overwrite one another and the drainage network never forms.
 *
 * What atomics do *not* buy is determinism. Additions commute, so the totals
 * are correct, but a droplet can read a cell midway through another droplet's
 * update, and the scheduling order varies per device. That is inherent to
 * parallel droplet erosion, and the honest response is to measure how much of
 * the divergence survives terracing rather than to claim it does not exist -
 * see erosionParity.test.ts.
 *
 * Spawn positions are supplied by the CPU rather than generated here, so that
 * the CPU and GPU runs start from byte-identical droplets and any difference
 * between their outputs is attributable to the races alone.
 */
export const EROSION_WGSL = /* wgsl */ `
struct Params {
  size: u32,
  droplets: u32,
  lifetime: u32,
  brushCount: u32,

  inertia: f32,
  capacityFactor: f32,
  minCapacity: f32,
  erodeSpeed: f32,

  depositSpeed: f32,
  evaporate: f32,
  gravity: f32,
  initialWater: f32,

  initialSpeed: f32,
  scale: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<storage, read_write> heightmap : array<atomic<i32>>;
@group(0) @binding(1) var<uniform> p : Params;
@group(0) @binding(2) var<storage, read> brushOffsets : array<i32>;
@group(0) @binding(3) var<storage, read> brushWeights : array<f32>;
@group(0) @binding(4) var<storage, read> spawns : array<f32>;

fn loadHeight(index: u32) -> f32 {
  return f32(atomicLoad(&heightmap[index])) / p.scale;
}

fn addHeight(index: u32, delta: f32) {
  let fixed = i32(round(delta * p.scale));
  if (fixed != 0) {
    atomicAdd(&heightmap[index], fixed);
  }
}

struct Sample {
  height: f32,
  gradX: f32,
  gradY: f32,
};

fn heightAndGradient(posX: f32, posY: f32) -> Sample {
  let coordX = i32(floor(posX));
  let coordY = i32(floor(posY));
  let x = posX - f32(coordX);
  let y = posY - f32(coordY);

  let i = u32(coordY) * p.size + u32(coordX);
  let nw = loadHeight(i);
  let ne = loadHeight(i + 1u);
  let sw = loadHeight(i + p.size);
  let se = loadHeight(i + p.size + 1u);

  var s: Sample;
  s.height = nw * (1.0 - x) * (1.0 - y) + ne * x * (1.0 - y) + sw * (1.0 - x) * y + se * x * y;
  s.gradX = (ne - nw) * (1.0 - y) + (se - sw) * y;
  s.gradY = (sw - nw) * (1.0 - x) + (se - ne) * x;
  return s;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let droplet = gid.x;
  if (droplet >= p.droplets) {
    return;
  }

  var posX = spawns[droplet * 2u];
  var posY = spawns[droplet * 2u + 1u];
  var dirX = 0.0;
  var dirY = 0.0;
  var speed = p.initialSpeed;
  var water = p.initialWater;
  var sediment = 0.0;

  let sizeF = f32(p.size);

  for (var step: u32 = 0u; step < p.lifetime; step = step + 1u) {
    let nodeX = i32(floor(posX));
    let nodeY = i32(floor(posY));
    let dropletIndex = u32(nodeY) * p.size + u32(nodeX);
    let cellOffsetX = posX - f32(nodeX);
    let cellOffsetY = posY - f32(nodeY);

    let s = heightAndGradient(posX, posY);

    dirX = dirX * p.inertia - s.gradX * (1.0 - p.inertia);
    dirY = dirY * p.inertia - s.gradY * (1.0 - p.inertia);

    let len = sqrt(dirX * dirX + dirY * dirY);
    if (len != 0.0) {
      dirX = dirX / len;
      dirY = dirY / len;
    }
    posX = posX + dirX;
    posY = posY + dirY;

    if ((dirX == 0.0 && dirY == 0.0) || posX < 1.0 || posX >= sizeF - 2.0 || posY < 1.0 || posY >= sizeF - 2.0) {
      break;
    }

    let next = heightAndGradient(posX, posY);
    let deltaHeight = next.height - s.height;

    let capacity = max(-deltaHeight * speed * water * p.capacityFactor, p.minCapacity);

    if (sediment > capacity || deltaHeight > 0.0) {
      var amount = (sediment - capacity) * p.depositSpeed;
      if (deltaHeight > 0.0) {
        amount = min(deltaHeight, sediment);
      }
      sediment = sediment - amount;

      addHeight(dropletIndex, amount * (1.0 - cellOffsetX) * (1.0 - cellOffsetY));
      addHeight(dropletIndex + 1u, amount * cellOffsetX * (1.0 - cellOffsetY));
      addHeight(dropletIndex + p.size, amount * (1.0 - cellOffsetX) * cellOffsetY);
      addHeight(dropletIndex + p.size + 1u, amount * cellOffsetX * cellOffsetY);
    } else {
      let amount = min((capacity - sediment) * p.erodeSpeed, -deltaHeight);
      for (var i: u32 = 0u; i < p.brushCount; i = i + 1u) {
        let bx = nodeX + brushOffsets[i * 2u];
        let by = nodeY + brushOffsets[i * 2u + 1u];
        if (bx < 0 || by < 0 || bx >= i32(p.size) || by >= i32(p.size)) {
          continue;
        }
        let idx = u32(by) * p.size + u32(bx);
        let weighted = amount * brushWeights[i];
        let current = loadHeight(idx);
        var delta = weighted;
        if (current < weighted) {
          delta = current;
        }
        addHeight(idx, -delta);
        sediment = sediment + delta;
      }
    }

    speed = sqrt(max(0.0, speed * speed - deltaHeight * p.gravity));
    water = water * (1.0 - p.evaporate);
    if (water < 0.01) {
      break;
    }
  }
}
`
