import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { generateBaseHeightfield, downsample, normalise, smoothField } from '@/render/terrain/heightfield'
import { erodeCPU } from '@/render/terrain/erosionCPU'
import { terrace } from '@/render/terrain/terrace'
import { terrainSeed } from '@/core/hash'
import { TERRAIN } from '@/core/config'

/**
 * Not an assertion - a diagnostic. Prints an ASCII map and a band histogram so
 * terrain tuning is a measurement instead of a screenshot guessing game.
 * Run with: pnpm vitest run tools/terrainProbe
 */
it('prints a terrain profile', () => {
  const seed = terrainSeed('first-isle')
  const t0 = performance.now()
  let field = generateBaseHeightfield(seed, TERRAIN.gridSize)
  const baseMs = performance.now() - t0

  const e = erodeCPU(field, seed, TERRAIN.dropletCount)
  field = normalise(e.field)

  const coarse = downsample(field, TERRAIN.terraceGrid)
  const smoothed = smoothField({ data: coarse.data.slice(), size: coarse.size }, TERRAIN.terraceSmoothing, 1)
  const tf = terrace(smoothed, TERRAIN.terraceBands, TERRAIN.worldSize, TERRAIN.peakHeight)

  const hist = new Array(TERRAIN.terraceBands).fill(0)
  let landCells = 0
  for (let i = 0; i < tf.land.length; i++) {
    if (!tf.land[i]) continue
    landCells++
    hist[tf.bands[i]]++
  }

  const ramp = ' .:-=+*#%@'
  let map = ''
  const step = Math.ceil(tf.size / 56)
  for (let y = 0; y < tf.size; y += step) {
    for (let x = 0; x < tf.size; x += step) {
      const i = y * tf.size + x
      map += tf.land[i] ? ramp[Math.min(9, Math.floor((tf.bands[i] / (TERRAIN.terraceBands - 1)) * 9))] : ' '
    }
    map += '\n'
  }

  const report = [
    map,
    `base gen ms   : ${baseMs.toFixed(0)}`,
    `erosion ms    : ${e.elapsedMs.toFixed(0)} (${e.droplets} droplets)`,
    `land cells    : ${landCells} of ${tf.land.length} (${((landCells / tf.land.length) * 100).toFixed(1)}%)`,
    `band histogram: ${hist.map((n, i) => `${i}:${((n / landCells) * 100).toFixed(1)}%`).join('  ')}`,
  ].join('\n')
  writeFileSync('terrain-probe.txt', report, 'utf8')
}, 120_000)
