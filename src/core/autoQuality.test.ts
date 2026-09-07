import { describe, expect, it } from 'vitest'
import { nextQualityStep, applyBenchmarkOutcome, FRAME_BUDGET_MS, BUDGET_TOLERANCE, SCALE_STEPS } from './autoQuality'
import { DEFAULT_SETTINGS } from './settings'

describe('nextQualityStep', () => {
  it('stops inside the budget and never steps up', () => {
    expect(nextQualityStep(8.3, 'medium', 1)).toEqual({ renderScale: 1, tier: 'medium', done: true })
    expect(nextQualityStep(16.7, 'medium', 0.75)).toEqual({ renderScale: 0.75, tier: 'medium', done: true })
    // Just inside the tolerance a 120 Hz panel needs.
    expect(nextQualityStep(FRAME_BUDGET_MS * BUDGET_TOLERANCE - 0.01, 'high', 1).done).toBe(true)
  })

  it('lowers the render scale before touching the tier', () => {
    expect(nextQualityStep(33, 'medium', 1)).toEqual({ renderScale: 0.85, tier: 'medium', done: false })
    expect(nextQualityStep(25, 'medium', 0.85)).toEqual({ renderScale: 0.75, tier: 'medium', done: false })
  })

  it('reproduces the Iris Xe run: three measurements, settles at Medium 75%', () => {
    let scale = 1
    const medians = [33, 25, 16.8]
    let step
    for (const m of medians) {
      step = nextQualityStep(m, 'medium', scale)
      scale = step.renderScale
      if (step.done) break
    }
    expect(step).toEqual({ renderScale: 0.75, tier: 'medium', done: true })
  })

  it('demotes the tier at full scale once the smallest scale still misses', () => {
    expect(nextQualityStep(30, 'medium', 0.66)).toEqual({ renderScale: 1, tier: 'low', done: true })
    expect(nextQualityStep(40, 'ultra', 0.66)).toEqual({ renderScale: 1, tier: 'high', done: true })
  })

  it('accepts what Low can do', () => {
    expect(nextQualityStep(50, 'low', 0.66)).toEqual({ renderScale: 0.66, tier: 'low', done: true })
  })

  it('a fit is remembered and clears any strike', () => {
    const next = applyBenchmarkOutcome({ ...DEFAULT_SETTINGS, demotionStrikes: 1 }, { renderScale: 0.75, tier: 'medium', done: true }, 'medium')
    expect(next).toMatchObject({ renderScale: 0.75, demotionStrikes: 0, benchmarked: true, autoTier: null })
  })

  it('one miss at the smallest scale is a strike, not a demotion', () => {
    // The desktop build's first run, with another app on the same GPU.
    const next = applyBenchmarkOutcome(DEFAULT_SETTINGS, { renderScale: 1, tier: 'low', done: true }, 'medium')
    expect(next.autoTier).toBeNull()
    expect(next.demotionStrikes).toBe(1)
    expect(next.benchmarked).toBe(false)
    // This session keeps the smallest scale rather than the tier's full one.
    expect(next.renderScale).toBe(SCALE_STEPS[SCALE_STEPS.length - 1])
  })

  it('the second start agreeing demotes, at full scale, to be measured again', () => {
    const struck = { ...DEFAULT_SETTINGS, demotionStrikes: 1 }
    const next = applyBenchmarkOutcome(struck, { renderScale: 1, tier: 'medium', done: true }, 'high')
    expect(next).toMatchObject({ autoTier: 'medium', renderScale: 1, demotionStrikes: 0, benchmarked: false })
    // Low is the floor: accepted as it is, nothing more to measure.
    const floor = applyBenchmarkOutcome(struck, { renderScale: 1, tier: 'low', done: true }, 'medium')
    expect(floor).toMatchObject({ autoTier: 'low', benchmarked: true })
  })

  it('treats a nonsense measurement as nothing to act on', () => {
    expect(nextQualityStep(Number.NaN, 'medium', 1).done).toBe(true)
    expect(nextQualityStep(Number.POSITIVE_INFINITY, 'medium', 1).done).toBe(true)
  })
})
