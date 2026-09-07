import { describe, it, expect } from 'vitest'
import { loadSettings, saveSettings, sanitise, DEFAULT_SETTINGS } from './settings'

/**
 * Device settings live outside the workspace on purpose, and they must never
 * be able to break the app: a private window, a hostile WebView and a stranger's
 * corrupt value are all ordinary inputs here.
 */

/** A Storage that behaves, and one that throws on everything. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k) },
    setItem: (k, v) => { map.set(k, String(v)) },
  }
}

function hostileStorage(): Storage {
  const boom = () => { throw new Error('SecurityError') }
  return {
    get length(): number { return boom() },
    clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom,
  }
}

describe('settings', () => {
  it('defaults when nothing is stored', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS)
  })

  it('is off-by-default for sound', () => {
    // Nothing should make noise unasked.
    expect(DEFAULT_SETTINGS.sound).toBe(false)
  })

  it('round-trips', () => {
    const storage = memoryStorage()
    saveSettings({ tier: 'high', autoTier: 'medium', sound: true, volume: 0.3, clouds: 0.9, hud: true, renderScale: 0.75, benchmarked: true, demotionStrikes: 1 }, storage)
    expect(loadSettings(storage)).toEqual({ tier: 'high', autoTier: 'medium', sound: true, volume: 0.3, clouds: 0.9, hud: true, renderScale: 0.75, benchmarked: true, demotionStrikes: 1 })
  })

  it('survives a storage that throws on every call', () => {
    const storage = hostileStorage()
    expect(() => saveSettings(DEFAULT_SETTINGS, storage)).not.toThrow()
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS)
  })

  it('survives no storage at all', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(DEFAULT_SETTINGS, null)).not.toThrow()
  })

  it('tolerates corrupt JSON', () => {
    const storage = memoryStorage()
    storage.setItem('tidewick.settings.v1', '{not json')
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS)
  })

  it('checks every field on its own, so one bad field costs one default', () => {
    const cleaned = sanitise({ tier: 'ludicrous', sound: 'yes', volume: 7, clouds: -2, hud: 1 })
    expect(cleaned.tier).toBeNull()
    expect(cleaned.sound).toBe(false)
    expect(cleaned.volume).toBe(1)
    expect(cleaned.clouds).toBe(0)
    expect(cleaned.hud).toBe(false)
  })

  it('accepts every real tier and nothing else', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(sanitise({ tier }).tier).toBe(tier)
    }
    expect(sanitise({ tier: 'Medium' }).tier).toBeNull()
  })

  it('handles a non-object value', () => {
    expect(sanitise(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitise(42)).toEqual(DEFAULT_SETTINGS)
    expect(sanitise('settings')).toEqual(DEFAULT_SETTINGS)
  })

  it('replaces a non-finite volume with a sensible one', () => {
    expect(sanitise({ volume: Number.NaN }).volume).toBe(0.5)
  })
})
