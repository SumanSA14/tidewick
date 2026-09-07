import type { QualityTier } from './config'

/**
 * Device settings.
 *
 * The one place state lives outside the workspace, and the exception is
 * principled: a quality tier, a sound toggle and a cloud-cover preference
 * describe *this machine and this person's ears*, not the isle. Putting them
 * in the workspace would export a phone's Low tier along with the tasks and
 * apply it to the desktop that imports them. Section 2 forbids game state
 * outside the workspace; none of this is game state.
 *
 * `localStorage`, wrapped in try/catch everywhere: it throws in some private
 * windows, some WebViews, and every thumbnail capture. A settings store that
 * crashes the app in a private window is worse than no settings store.
 */

export interface DeviceSettings {
  /** Override the auto-detected quality tier, or null to keep detection. */
  tier: QualityTier | null
  /**
   * The tier the first-run benchmark settled on, when it stepped below the
   * detected one. Applied when `tier` is null; shown as "benchmarked".
   */
  autoTier: QualityTier | null
  /** Ambient sound on. Off by default: nothing should make noise unasked. */
  sound: boolean
  /** Ambient volume, 0..1. */
  volume: number
  /** 0..1 cloud cover. Weather is cosmetic; this is the knob. */
  clouds: number
  /** Show the performance HUD on start. */
  hud: boolean
  /** Internal render resolution as a fraction of the display's, 0.5-1. */
  renderScale: number
  /**
   * True once the first-run frame benchmark has decided the tier for this
   * device, so it runs once rather than on every start. Cleared when the tier
   * is set back to automatic.
   */
  benchmarked: boolean
  /** Consecutive starts whose benchmark missed at the smallest scale; see `applyBenchmarkOutcome`. */
  demotionStrikes: number
}

export const DEFAULT_SETTINGS: DeviceSettings = {
  tier: null,
  autoTier: null,
  sound: false,
  volume: 0.5,
  clouds: 0.42,
  hud: false,
  renderScale: 1,
  benchmarked: false,
  demotionStrikes: 0,
}

const KEY = 'tidewick.settings.v1'

const TIERS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'ultra'])

/** Read, tolerating anything: a missing key, a corrupt value, a stranger's schema. */
export function loadSettings(storage: Storage | null = safeStorage()): DeviceSettings {
  if (!storage) return { ...DEFAULT_SETTINGS }
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return sanitise(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: DeviceSettings, storage: Storage | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(sanitise(settings)))
  } catch {
    // Quota, private mode, or a WebView that says no. The setting still
    // applies for this session; it simply will not be remembered.
  }
}

/**
 * Clamp and type-check a parsed value. Every field is checked individually so
 * one bad field costs one default rather than the whole record.
 */
export function sanitise(value: unknown): DeviceSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    tier: typeof v.tier === 'string' && TIERS.has(v.tier) ? (v.tier as QualityTier) : null,
    autoTier: typeof v.autoTier === 'string' && TIERS.has(v.autoTier) ? (v.autoTier as QualityTier) : null,
    sound: v.sound === true,
    volume: clamp01(typeof v.volume === 'number' ? v.volume : DEFAULT_SETTINGS.volume),
    clouds: clamp01(typeof v.clouds === 'number' ? v.clouds : DEFAULT_SETTINGS.clouds),
    hud: v.hud === true,
    renderScale: clampScale(typeof v.renderScale === 'number' ? v.renderScale : 1),
    benchmarked: v.benchmarked === true,
    demotionStrikes: typeof v.demotionStrikes === 'number' && Number.isFinite(v.demotionStrikes) ? Math.max(0, Math.min(9, Math.floor(v.demotionStrikes))) : 0,
  }
}

function clampScale(n: number): number {
  return Number.isFinite(n) ? Math.max(0.5, Math.min(1, n)) : 1
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    // Touching the object can itself throw in a blocked context.
    void window.localStorage.length
    return window.localStorage
  } catch {
    return null
  }
}
