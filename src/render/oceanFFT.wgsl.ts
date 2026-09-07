/**
 * Spectral ocean: Phillips spectrum and a Stockham IFFT, in WGSL compute.
 *
 * This is the WebGPU path for the sea. The WebGL2 fallback uses the four-wave
 * Gerstner sum in `ocean.ts` instead - not as a stopgap but because WebGL2 has
 * no compute shaders at all, and an IFFT built from ping-pong framebuffers
 * costs more than the visual difference is worth at diorama distance.
 *
 * The method is Tessendorf's. A height field is built in frequency space from
 * the Phillips spectrum, animated by rotating each frequency component by its
 * own dispersion phase, then transformed back to a spatial displacement map by
 * an inverse FFT. The transform is what needs the GPU: a 256x256 IFFT is 2x256
 * one-dimensional transforms of 256 points, every frame.
 *
 * Stockham rather than Cooley-Tukey: it writes to a separate output buffer each
 * pass and so needs no bit-reversal permutation, which is both a separate
 * kernel and the step everyone gets subtly wrong.
 *
 * Written and validated with naga; **not executed** - no machine available to
 * this project has a WebGPU adapter. See the README.
 */
export const OCEAN_SPECTRUM_WGSL = /* wgsl */ `
struct Params {
  size: u32,          // grid resolution, a power of two
  patchMetres: f32,   // world size the patch tiles over
  time: f32,
  amplitude: f32,     // Phillips A
  windX: f32,
  windZ: f32,
  windSpeed: f32,
  gravity: f32,
};

@group(0) @binding(0) var<uniform> p : Params;
// h0 holds the time-independent spectrum: (re, im) for k and for -k.
@group(0) @binding(1) var<storage, read> h0 : array<vec4<f32>>;
// Output: the animated spectrum, one complex value per cell.
@group(0) @binding(2) var<storage, read_write> spectrum : array<vec2<f32>>;

fn complexMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/**
 * Dispersion for deep water: omega = sqrt(g * |k|).
 *
 * Quantised to a multiple of the fundamental frequency so the whole surface
 * repeats on a fixed period instead of drifting out of phase forever - which
 * is what stops a tiling ocean from visibly seaming after a few minutes.
 */
fn dispersion(k: vec2<f32>) -> f32 {
  let w0 = 6.28318530718 / 200.0;
  let magnitude = max(length(k), 1e-6);
  return floor(sqrt(p.gravity * magnitude) / w0) * w0;
}

@compute @workgroup_size(8, 8)
fn spectrumAt(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = p.size;
  if (gid.x >= n || gid.y >= n) {
    return;
  }

  let index = gid.y * n + gid.x;
  let half = f32(n) * 0.5;
  let k = vec2<f32>(
    (f32(gid.x) - half) * 6.28318530718 / p.patchMetres,
    (f32(gid.y) - half) * 6.28318530718 / p.patchMetres,
  );

  let omega = dispersion(k) * p.time;
  let rotation = vec2<f32>(cos(omega), sin(omega));

  let pair = h0[index];
  let hk = vec2<f32>(pair.x, pair.y);
  let hMinusK = vec2<f32>(pair.z, -pair.w);

  // h(k, t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
  let forward = complexMul(hk, rotation);
  let backward = complexMul(hMinusK, vec2<f32>(rotation.x, -rotation.y));
  spectrum[index] = forward + backward;
}
`

export const OCEAN_IFFT_WGSL = /* wgsl */ `
struct FftParams {
  size: u32,       // transform length, a power of two
  stride: u32,     // butterfly span for this pass
  horizontal: u32, // 1 for rows, 0 for columns
  inverse: u32,    // 1 to divide by N on the final pass
};

@group(0) @binding(0) var<uniform> f : FftParams;
@group(0) @binding(1) var<storage, read> src : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst : array<vec2<f32>>;

fn complexMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/**
 * One Stockham pass.
 *
 * Named butterflyPass rather than pass, because "pass" is a reserved word in
 * WGSL - the kind of thing that compiles fine in your head and fails only on a
 * machine with a GPU, which is why these shaders are checked with naga in CI.
 *
 * Each invocation handles one butterfly. Reading from src and writing to
 * dst is what removes the need for a bit-reversal permutation: the data
 * comes out in natural order, and the caller simply swaps the two buffers
 * between passes.
 */
@compute @workgroup_size(64)
fn butterflyPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = f.size;
  let halfN = n / 2u;
  let line = gid.y;
  let j = gid.x;

  if (j >= halfN || line >= n) {
    return;
  }

  let span = f.stride;
  let group = j / span;
  let offset = j % span;

  let inLow = group * span + offset;
  let inHigh = inLow + halfN;
  let outLow = group * span * 2u + offset;
  let outHigh = outLow + span;

  // Index into the row or the column, depending on which axis this pass runs.
  var iLow: u32;
  var iHigh: u32;
  var oLow: u32;
  var oHigh: u32;
  if (f.horizontal == 1u) {
    iLow = line * n + inLow;
    iHigh = line * n + inHigh;
    oLow = line * n + outLow;
    oHigh = line * n + outHigh;
  } else {
    iLow = inLow * n + line;
    iHigh = inHigh * n + line;
    oLow = outLow * n + line;
    oHigh = outHigh * n + line;
  }

  let angle = 6.28318530718 * f32(offset) / (f32(span) * 2.0);
  // Positive angle for the inverse transform, negative for the forward one.
  let sign = select(-1.0, 1.0, f.inverse == 1u);
  let twiddle = vec2<f32>(cos(angle), sign * sin(angle));

  let a = src[iLow];
  let b = complexMul(src[iHigh], twiddle);

  dst[oLow] = a + b;
  dst[oHigh] = a - b;
}

/** Final scaling and the checkerboard sign flip that recentres the patch. */
@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = f.size;
  if (gid.x >= n || gid.y >= n) {
    return;
  }
  let index = gid.y * n + gid.x;
  let flip = select(-1.0, 1.0, ((gid.x + gid.y) & 1u) == 0u);
  dst[index] = src[index] * (flip / f32(n * n));
}
`

/**
 * The Phillips spectrum, evaluated on the CPU once at startup.
 *
 * Time-independent, so there is no reason to recompute it per frame - the
 * animation is entirely in the phase rotation the compute shader applies. Kept
 * here beside the shader that consumes it so the two stay in step.
 */
export function phillipsSpectrum(
  size: number,
  patchMetres: number,
  windX: number,
  windZ: number,
  windSpeed: number,
  amplitude: number,
  random: () => number,
): Float32Array {
  const out = new Float32Array(size * size * 4)
  const gravity = 9.81
  const largest = (windSpeed * windSpeed) / gravity
  // Smallest wave that survives: below this, capillary detail is noise at any
  // sane resolution and only makes the surface sparkle.
  const smallest = patchMetres / size / 2

  const windLength = Math.hypot(windX, windZ) || 1
  const wx = windX / windLength
  const wz = windZ / windLength

  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const kx = ((x - half) * 2 * Math.PI) / patchMetres
      const kz = ((y - half) * 2 * Math.PI) / patchMetres
      const index = (y * size + x) * 4

      const k2 = kx * kx + kz * kz
      if (k2 < 1e-12) continue

      const kLength = Math.sqrt(k2)
      const cosine = (kx / kLength) * wx + (kz / kLength) * wz
      // Squared, so waves travelling across the wind are suppressed and those
      // travelling against it are not simply mirrored.
      const directional = cosine * cosine
      const phillips =
        amplitude *
        (Math.exp(-1 / (k2 * largest * largest)) / (k2 * k2)) *
        directional *
        Math.exp(-k2 * smallest * smallest)

      const scale = Math.sqrt(Math.max(0, phillips) / 2)
      const [g1, g2] = gaussianPair(random)
      const [g3, g4] = gaussianPair(random)

      out[index] = g1 * scale
      out[index + 1] = g2 * scale
      out[index + 2] = g3 * scale
      out[index + 3] = g4 * scale
    }
  }

  return out
}

/** Box-Muller: two independent normals from two uniforms. */
function gaussianPair(random: () => number): [number, number] {
  let u = random()
  // log(0) is -Infinity, and one unlucky sample would poison the whole patch.
  if (u < 1e-9) u = 1e-9
  const radius = Math.sqrt(-2 * Math.log(u))
  const angle = 2 * Math.PI * random()
  return [radius * Math.cos(angle), radius * Math.sin(angle)]
}
