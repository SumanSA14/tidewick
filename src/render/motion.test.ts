import { describe, it, expect } from 'vitest'
import { agentsFor, setMotionScale, uMotion } from './motion'
import { TIER_BUDGETS } from '@/core/config'

describe('reduced motion on the isle', () => {
  it('leaves every tier alone when motion is not reduced', () => {
    for (const tier of Object.values(TIER_BUDGETS)) {
      expect(agentsFor(tier.agents, false)).toBe(tier.agents)
    }
  })

  it('thins the flock to a third, never below a handful, never up from zero', () => {
    expect(agentsFor(900, true)).toBe(300)
    expect(agentsFor(1_600, true)).toBe(533)
    // Low has 120 birds; a third is 40 and stays above the floor.
    expect(agentsFor(120, true)).toBe(40)
    // A tiny budget is floored rather than emptied: the isle stays inhabited.
    expect(agentsFor(30, true)).toBe(24)
    // A tier with no birds gets no birds. Reduced motion never adds motion.
    expect(agentsFor(0, true)).toBe(0)
  })

  it('every tier still has birds under reduced motion', () => {
    for (const tier of Object.values(TIER_BUDGETS)) {
      expect(agentsFor(tier.agents, true)).toBeGreaterThan(0)
      expect(agentsFor(tier.agents, true)).toBeLessThan(tier.agents)
    }
  })

  it('drives one uniform, clamped to [0, 1], and rests at exactly zero', () => {
    setMotionScale(1)
    expect(uMotion.value).toBe(1)
    setMotionScale(0)
    // Exactly zero, not "small": the still picture must be the rest pose, so
    // sin(0 * f + phase) is the same on every frame and every machine.
    expect(uMotion.value).toBe(0)
    setMotionScale(4)
    expect(uMotion.value).toBe(1)
    setMotionScale(-1)
    expect(uMotion.value).toBe(0)
    setMotionScale(1)
  })
})
