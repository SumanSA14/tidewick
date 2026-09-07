import { Color } from 'three'

/**
 * Season palettes.
 *
 * Four palettes, cross-faded at season boundaries, with the workspace accent
 * drawn from whichever is active - so the DOM half and the island half are
 * visibly the same product rather than two apps in one window.
 *
 * Note what is absent: there is no red anywhere in this file, and there is not
 * going to be. Urgency in this product is proximity to water and nothing else,
 * so the palette is never asked to carry alarm.
 */
export interface SeasonPalette {
  id: string
  name: string
  skyTop: Color
  skyHorizon: Color
  sun: Color
  ambient: Color
  water: Color
  waterDeep: Color
  foam: Color
  outline: Color
  /** Hex string handed to the DOM half as its accent. */
  accent: string
}

const c = (hex: number) => new Color(hex)

export const SEASONS: SeasonPalette[] = [
  {
    id: 'first-light',
    name: 'First Light',
    skyTop: c(0x63b8e8), skyHorizon: c(0xd6f0f7),
    sun: c(0xfff8ea), ambient: c(0xcdc7b6),
    water: c(0x6fdcd6), waterDeep: c(0x2a86ad), foam: c(0xfbffff),
    outline: c(0x2b3a45), accent: '#3f8fa8',
  },
  {
    id: 'high-green',
    name: 'High Green',
    skyTop: c(0x4c9de0), skyHorizon: c(0xd8f0e4),
    sun: c(0xfff6dc), ambient: c(0x93c4a8),
    water: c(0x3fbfbf), waterDeep: c(0x15637a), foam: c(0xf7fffb),
    outline: c(0x24382f), accent: '#3f8f6a',
  },
  {
    id: 'lantern-gold',
    name: 'Lantern Gold',
    skyTop: c(0x6b8fc4), skyHorizon: c(0xf6d9a8),
    sun: c(0xffd79a), ambient: c(0xb79a86),
    water: c(0x3f9db0), waterDeep: c(0x1a5570), foam: c(0xfff4e2),
    outline: c(0x3a2f2a), accent: '#b8804a',
  },
  {
    id: 'quiet-blue',
    name: 'Quiet Blue',
    skyTop: c(0x6d84b4), skyHorizon: c(0xdfe6f2),
    sun: c(0xeaf0ff), ambient: c(0x9aa8c0),
    water: c(0x4a8fae), waterDeep: c(0x1d4a68), foam: c(0xf2f8ff),
    outline: c(0x2b3140), accent: '#5b7fa8',
  },
]

export function seasonAt(index: number): SeasonPalette {
  return SEASONS[((index % SEASONS.length) + SEASONS.length) % SEASONS.length]
}

/**
 * A palette part-way between two seasons.
 *
 * Section 8 asks for a cross-fade rather than a switch: the isle should change
 * the way a season changes, which is to say you notice one morning that it
 * already has. Interpolating in linear RGB rather than sRGB keeps the mid-point
 * from going muddy, which is what makes a green-to-gold fade look like autumn
 * instead of like mud.
 */
export function blendSeasons(from: number, to: number, t: number): SeasonPalette {
  const a = seasonAt(from)
  const b = seasonAt(to)
  const k = Math.max(0, Math.min(1, t))
  if (k <= 0) return a
  if (k >= 1) return b

  return {
    id: `${a.id}->${b.id}`,
    name: k < 0.5 ? a.name : b.name,
    skyTop: mixColor(a.skyTop, b.skyTop, k),
    skyHorizon: mixColor(a.skyHorizon, b.skyHorizon, k),
    sun: mixColor(a.sun, b.sun, k),
    ambient: mixColor(a.ambient, b.ambient, k),
    water: mixColor(a.water, b.water, k),
    waterDeep: mixColor(a.waterDeep, b.waterDeep, k),
    foam: mixColor(a.foam, b.foam, k),
    outline: mixColor(a.outline, b.outline, k),
    accent: mixHex(a.accent, b.accent, k),
  }
}

/** `Color.lerpColors` works in whatever space the colours are already in. */
function mixColor(a: Color, b: Color, t: number): Color {
  return new Color().lerpColors(a, b, t)
}

function mixHex(a: string, b: string, t: number): string {
  return `#${new Color(a).lerp(new Color(b), t).getHexString()}`
}
