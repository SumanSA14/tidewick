import { describe, it, expect } from 'vitest'
import { TIER_BUDGETS, budgetFor, type QualityTier, type TierBudget } from './config'

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra']

describe('quality tiers', () => {
  it('never spend less as the tier rises', () => {
    const keys: Array<keyof TierBudget> = ['grass', 'agents', 'shadowSize', 'droplets', 'bloom', 'godrays']
    for (const key of keys) {
      for (let i = 1; i < ORDER.length; i++) {
        const lower = TIER_BUDGETS[ORDER[i - 1]][key] as number
        const higher = TIER_BUDGETS[ORDER[i]][key] as number
        expect(higher, `${key}: ${ORDER[i]} < ${ORDER[i - 1]}`).toBeGreaterThanOrEqual(lower)
      }
    }
  })

  it('applies development overrides by field, typed like the field', () => {
    const b = budgetFor('medium', { 'budget.bloom': '0', 'budget.shadowSize': '1024', 'budget.outlineNormals': '0', 'budget.nonsense': '9', 'unrelated': 'x' })
    expect(b.bloom).toBe(0)
    expect(b.shadowSize).toBe(1024)
    expect(b.outlineNormals).toBe(false)
    expect(b.grass).toBe(TIER_BUDGETS.medium.grass)
    expect('nonsense' in b).toBe(false)
    // No overrides: the tier itself, untouched.
    expect(budgetFor('high', {})).toEqual(TIER_BUDGETS.high)
  })

  it('Low must run on a phone: no grass, no post glow, no raymarch', () => {
    expect(TIER_BUDGETS.low.grass).toBe(0)
    expect(TIER_BUDGETS.low.bloom).toBe(0)
    expect(TIER_BUDGETS.low.godrays).toBe(0)
  })

  it('meets the brief\'s instance counts where the tier claims to', () => {
    // Section 15: >= 250k blades at Medium, >= 1M at High.
    expect(TIER_BUDGETS.medium.grass).toBeGreaterThanOrEqual(250_000)
    expect(TIER_BUDGETS.high.grass).toBeGreaterThanOrEqual(1_000_000)
  })

  it('builds god-rays nowhere until someone has looked at them', () => {
    // The pass exists and runs; it was turned off after being seen. See the
    // note on TierBudget.godrays. Turning it on at a tier is an art decision
    // that needs a visible window, so this fails loudly if it happens by
    // accident in a config edit.
    for (const tier of Object.values(TIER_BUDGETS)) expect(tier.godrays).toBe(0)
  })
})
