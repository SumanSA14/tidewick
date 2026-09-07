/**
 * Seeded pseudo-randomness and gradient noise.
 *
 * Everything here is deterministic given a seed. No Math.random anywhere in
 * the terrain pipeline: the same workspace must always grow the same island,
 * on every machine, in every session.
 */

/** Mulberry32 — small, fast, good enough distribution for terrain. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 2D Perlin gradient noise over a seeded permutation table. */
export class Perlin2D {
  private readonly perm: Uint8Array

  constructor(seed: number) {
    const rand = mulberry32(seed)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    // Fisher-Yates with the seeded generator.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const tmp = p[i]
      p[i] = p[j]
      p[j] = tmp
    }
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
  }

  private static grad(hash: number, x: number, y: number): number {
    // 8 gradient directions, selected by the low 3 bits.
    switch (hash & 7) {
      case 0: return x + y
      case 1: return -x + y
      case 2: return x - y
      case 3: return -x - y
      case 4: return x
      case 5: return -x
      case 6: return y
      default: return -y
    }
  }

  /** Returns roughly [-1, 1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)

    const u = Perlin2D.fade(xf)
    const v = Perlin2D.fade(yf)

    const p = this.perm
    const aa = p[p[xi] + yi]
    const ab = p[p[xi] + yi + 1]
    const ba = p[p[xi + 1] + yi]
    const bb = p[p[xi + 1] + yi + 1]

    const x1 = lerp(Perlin2D.grad(aa, xf, yf), Perlin2D.grad(ba, xf - 1, yf), u)
    const x2 = lerp(Perlin2D.grad(ab, xf, yf - 1), Perlin2D.grad(bb, xf - 1, yf - 1), u)
    return lerp(x1, x2, v)
  }

  /** Fractal Brownian motion: octaves of noise at doubling frequency. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amplitude = 1
    let frequency = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * frequency, y * frequency) * amplitude
      norm += amplitude
      amplitude *= gain
      frequency *= lacunarity
    }
    return norm > 0 ? sum / norm : 0
  }

  /**
   * Ridged multifractal. Produces sharp ridgelines rather than rolling hills,
   * which is what gives the island a spine for the erosion to carve against.
   */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amplitude = 1
    let frequency = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * frequency, y * frequency))
      sum += n * n * amplitude
      norm += amplitude
      amplitude *= gain
      frequency *= lacunarity
    }
    return norm > 0 ? sum / norm : 0
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
