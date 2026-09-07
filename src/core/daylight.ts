/**
 * Time of day, driven by the real clock.
 *
 * The island is a portrait of your work, and work happens at a time. Opening
 * Tidewick at seven in the morning and at nine at night should not look the
 * same - not as a gimmick, but because it is the cheapest possible way to make
 * the place feel inhabited rather than rendered.
 *
 * Kept deliberately free of three.js so it can be unit-tested and reused by the
 * DOM half, which draws its accent colour from the same source. The workspace
 * and the isle are one product; they should not disagree about what colour the
 * evening is.
 */

export type DayPhase = 'night' | 'dawn' | 'morning' | 'day' | 'golden' | 'dusk'

export interface RGB {
  r: number
  g: number
  b: number
}

export interface DaylightState {
  /** Fractional hours since local midnight, [0, 24). */
  hour: number
  phase: DayPhase
  skyTop: RGB
  skyHorizon: RGB
  /** Warm scatter near the sun. Strong at dawn and dusk, absent at noon. */
  glow: RGB
  glowPower: number
  sun: RGB
  ambient: RGB
  sunIntensity: number
  ambientIntensity: number
  /** Sun direction, normalised, in world space (Y up). */
  sunDirection: { x: number; y: number; z: number }
  /** 0 at deep night, 1 at midday. Drives lantern brightness later. */
  daylight: number
}

interface Keyframe {
  hour: number
  phase: DayPhase
  skyTop: number
  skyHorizon: number
  glow: number
  glowPower: number
  sun: number
  ambient: number
  sunIntensity: number
  ambientIntensity: number
}

/**
 * Keyframes around the clock. Interpolated cyclically, so 23:00 blends into
 * 01:00 without a seam at midnight - a surprisingly easy thing to get wrong and
 * a very visible one when you do.
 */
const KEYFRAMES: Keyframe[] = [
  { hour: 0,    phase: 'night',   skyTop: 0x0b1a33, skyHorizon: 0x1b2c47, glow: 0x2a3a5c, glowPower: 3,  sun: 0x9fb4d8, ambient: 0x1e2a40, sunIntensity: 0.30, ambientIntensity: 0.55 },
  { hour: 5,    phase: 'night',   skyTop: 0x142544, skyHorizon: 0x3a3f60, glow: 0x6a5878, glowPower: 4,  sun: 0xb9bede, ambient: 0x2b3450, sunIntensity: 0.38, ambientIntensity: 0.62 },
  { hour: 6.5,  phase: 'dawn',    skyTop: 0x3f6396, skyHorizon: 0xf0a878, glow: 0xffb07a, glowPower: 6,  sun: 0xffc9a0, ambient: 0x8a8296, sunIntensity: 1.35, ambientIntensity: 1.05 },
  { hour: 8.5,  phase: 'morning', skyTop: 0x5fb0e8, skyHorizon: 0xd9ecf6, glow: 0xffe6c0, glowPower: 10, sun: 0xfff2d8, ambient: 0xc6c6b4, sunIntensity: 2.30, ambientIntensity: 1.35 },
  { hour: 13,   phase: 'day',     skyTop: 0x4aa8e0, skyHorizon: 0xd6f0f7, glow: 0xffffff, glowPower: 22, sun: 0xfff8ea, ambient: 0xcdc7b6, sunIntensity: 2.55, ambientIntensity: 1.42 },
  { hour: 17,   phase: 'day',     skyTop: 0x53a6dd, skyHorizon: 0xe4e9ee, glow: 0xffeccd, glowPower: 14, sun: 0xfff1d6, ambient: 0xc8c2ae, sunIntensity: 2.40, ambientIntensity: 1.38 },
  { hour: 19,   phase: 'golden',  skyTop: 0x6b8fc4, skyHorizon: 0xf6c98a, glow: 0xffb570, glowPower: 7,  sun: 0xffcf8a, ambient: 0xbda28a, sunIntensity: 2.05, ambientIntensity: 1.20 },
  { hour: 20.5, phase: 'dusk',    skyTop: 0x2e4a7a, skyHorizon: 0xdd8a68, glow: 0xff9a68, glowPower: 5,  sun: 0xff9f76, ambient: 0x6f6a84, sunIntensity: 0.85, ambientIntensity: 0.75 },
  { hour: 22,   phase: 'night',   skyTop: 0x122344, skyHorizon: 0x22304c, glow: 0x3d3f66, glowPower: 3,  sun: 0xa8b6d6, ambient: 0x232e46, sunIntensity: 0.34, ambientIntensity: 0.58 },
]

const SUNRISE_HOUR = 5
const SUNSET_HOUR = 20
const SUN_MIN_ELEVATION = 0.30
const SUN_MAX_ELEVATION = 0.66

function rgb(hex: number): RGB {
  return {
    r: ((hex >> 16) & 0xff) / 255,
    g: ((hex >> 8) & 0xff) / 255,
    b: (hex & 0xff) / 255,
  }
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Smootherstep. Gentler than linear at the keyframe joins, which show up as
 *  a visible kink in the sky otherwise. */
function ease(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export function daylightAt(date: Date = new Date()): DaylightState {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600
  return daylightAtHour(hour)
}

export function daylightAtHour(hour: number): DaylightState {
  const h = ((hour % 24) + 24) % 24

  // Find the bracketing keyframes, wrapping around midnight.
  let i = 0
  for (let k = 0; k < KEYFRAMES.length; k++) {
    if (KEYFRAMES[k].hour <= h) i = k
  }
  const a = KEYFRAMES[i]
  const b = KEYFRAMES[(i + 1) % KEYFRAMES.length]
  const spanEnd = b.hour > a.hour ? b.hour : b.hour + 24
  const t = ease((h - a.hour) / Math.max(1e-6, spanEnd - a.hour))

  // Sun angle. A plain sinusoid rather than real ephemeris: this is a cozy
  // island, not an orrery, and nobody is going to check the declination.
  //
  // The arc runs 05:00 to 20:00 rather than a tidy 06:00-18:00. A twelve-hour
  // arc puts the sun near the horizon through most of the hours anyone
  // actually works, so every plateau sits in its own shadow all afternoon.
  const dayAngle = ((h - SUNRISE_HOUR) / (SUNSET_HOUR - SUNRISE_HOUR)) * Math.PI
  const altitude = Math.sin(dayAngle)
  const azimuth = Math.cos(dayAngle)

  // Art-directed elevation range rather than a true solar altitude.
  //
  // A physically-honest sun is directly overhead at noon, and an overhead sun
  // on terraced terrain is the worst possible light: every plateau top is
  // uniformly lit, no riser catches a shadow, and the whole island flattens
  // into a pale blob exactly when someone is most likely to be looking at it.
  // Clamping the arc into [0.30, 0.66] keeps a raking angle at every hour, so
  // the terraces always read. Cozy games light for legibility, not for
  // astronomy - and the colour ramp is doing the work of telling time anyway.
  const y = SUN_MIN_ELEVATION + Math.max(0, altitude) * (SUN_MAX_ELEVATION - SUN_MIN_ELEVATION)
  const len = Math.hypot(azimuth, y, 0.45)

  const sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t)

  return {
    hour: h,
    phase: t < 0.5 ? a.phase : b.phase,
    skyTop: mixRGB(rgb(a.skyTop), rgb(b.skyTop), t),
    skyHorizon: mixRGB(rgb(a.skyHorizon), rgb(b.skyHorizon), t),
    glow: mixRGB(rgb(a.glow), rgb(b.glow), t),
    glowPower: lerp(a.glowPower, b.glowPower, t),
    sun: mixRGB(rgb(a.sun), rgb(b.sun), t),
    ambient: mixRGB(rgb(a.ambient), rgb(b.ambient), t),
    sunIntensity,
    ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, t),
    sunDirection: { x: azimuth / len, y: y / len, z: 0.45 / len },
    daylight: Math.max(0, Math.min(1, (sunIntensity - 0.3) / 2.25)),
  }
}

/** Human phrasing for the home page. Warm, never chirpy. */
export function greetingFor(phase: DayPhase): string {
  switch (phase) {
    case 'dawn': return 'Early light'
    case 'morning': return 'Good morning'
    case 'day': return 'Good afternoon'
    case 'golden': return 'Golden hour'
    case 'dusk': return 'Good evening'
    case 'night': return 'Quiet hours'
  }
}

/** A hex string the DOM half can use, so both halves agree about the hour. */
export function toHex(c: RGB): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`
}
