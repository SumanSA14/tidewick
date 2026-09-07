import { describe, expect, it } from 'vitest'
import { tierForAdapter } from './capability'

describe('tierForAdapter', () => {
  it('calls Intel integrated graphics Medium - the tier the 60 fps budget is written against', () => {
    // The adapter Edge reports for this laptop's Iris Xe. The old limits-based
    // heuristic said High; High measured 92 ms per frame there.
    expect(tierForAdapter({ vendor: 'intel', architecture: 'gen-12lp' }, true)).toBe('medium')
    expect(tierForAdapter({ vendor: 'intel', architecture: 'gen-9' }, true)).toBe('medium')
    expect(tierForAdapter({ vendor: 'intel', architecture: 'xe-lpg' }, true)).toBe('medium')
  })

  it('treats Intel Arc as the discrete card it is', () => {
    expect(tierForAdapter({ vendor: 'intel', architecture: 'xe-hpg' }, true)).toBe('high')
  })

  it('starts discrete and Apple GPUs at High', () => {
    expect(tierForAdapter({ vendor: 'nvidia', architecture: 'ampere' }, true)).toBe('high')
    expect(tierForAdapter({ vendor: 'amd', architecture: 'rdna-3' }, true)).toBe('high')
    expect(tierForAdapter({ vendor: 'apple', architecture: 'metal-3' }, true)).toBe('high')
  })

  it('starts phones at Low, because Low must run on a phone', () => {
    expect(tierForAdapter({ vendor: 'qualcomm', architecture: 'adreno-7xx' }, true)).toBe('low')
    expect(tierForAdapter({ vendor: 'arm', architecture: 'valhall' }, true)).toBe('low')
  })

  it('is Medium when it knows nothing, and always Medium without compute', () => {
    expect(tierForAdapter(undefined, true)).toBe('medium')
    expect(tierForAdapter({}, true)).toBe('medium')
    expect(tierForAdapter({ vendor: 'nvidia' }, false)).toBe('medium')
  })
})
