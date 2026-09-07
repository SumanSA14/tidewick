/**
 * Ambient sound, generated.
 *
 * There is no audio pipeline in this project and no assets, so the sea, the
 * wind and the lantern chime are synthesised: filtered noise for the two
 * ambiences, a few sine partials for the chime. It is cheap for the warmth it
 * buys - the brief's own words for why sound is in scope - and it means the
 * bundle carries no samples.
 *
 * Off by default, always. Nothing here makes a sound until the person asks
 * for it, and the AudioContext is not even created until then: browsers block
 * autoplay, and a context created at boot spends its life suspended and
 * logging warnings.
 *
 * Everything is gentle. The sea is a slow swell rather than crashing surf, the
 * wind rises and falls over a minute, and the chime is one soft bell with a
 * long decay. This is a place to sit.
 */

export interface Ambience {
  /** Start the sea and wind. Idempotent. Resolves once audio is running. */
  start(): Promise<void>
  stop(): void
  /** 0..1 master volume. */
  setVolume(volume: number): void
  /** Wind strength, 0..1 - the same knob the grass sways to. */
  setWind(strength: number): void
  /** A single warm bell, for a lantern lighting. */
  chime(): void
  /** True while running. */
  readonly running: boolean
  dispose(): void
}

/** Seconds of noise to bake. Long enough that the loop is never noticed. */
const NOISE_SECONDS = 6

export function createAmbience(): Ambience {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let windGain: GainNode | null = null
  let running = false
  let volume = 0.5
  let wind = 0.5
  let lfoTimer = 0

  const ensure = async (): Promise<AudioContext | null> => {
    if (typeof window === 'undefined') return null
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!context) {
      context = new Ctor()
      master = context.createGain()
      master.gain.value = 0
      master.connect(context.destination)
      buildSea(context, master)
      windGain = buildWind(context, master)
    }
    if (context.state === 'suspended') await context.resume()
    return context
  }

  const applyVolume = () => {
    if (!context || !master) return
    // A fade, not a jump: a gain step is a click.
    const now = context.currentTime
    master.gain.cancelScheduledValues(now)
    master.gain.setTargetAtTime(running ? volume * 0.6 : 0, now, 0.4)
  }

  const applyWind = () => {
    if (!context || !windGain) return
    windGain.gain.setTargetAtTime(0.08 + wind * 0.32, context.currentTime, 1.2)
  }

  return {
    get running() { return running },

    async start() {
      const ctx = await ensure()
      if (!ctx) return
      running = true
      applyVolume()
      applyWind()
      // A slow breath in the wind level so it never sits at one value.
      if (!lfoTimer) {
        lfoTimer = window.setInterval(() => {
          if (!windGain || !context) return
          const breath = 0.5 + 0.5 * Math.sin(context.currentTime * 0.09)
          windGain.gain.setTargetAtTime(0.08 + wind * (0.18 + breath * 0.2), context.currentTime, 2.5)
        }, 1500)
      }
    },

    stop() {
      running = false
      applyVolume()
      if (lfoTimer) { window.clearInterval(lfoTimer); lfoTimer = 0 }
    },

    setVolume(v) {
      volume = Math.max(0, Math.min(1, v))
      applyVolume()
    },

    setWind(strength) {
      wind = Math.max(0, Math.min(1, strength))
      applyWind()
    },

    chime() {
      if (!context || !master || !running) return
      bell(context, master, volume)
    },

    dispose() {
      this.stop()
      void context?.close()
      context = null
      master = null
      windGain = null
    },
  }
}

/** A buffer of pink-ish noise, looped. Brown for the sea, filtered white for wind. */
function noiseBuffer(context: AudioContext, brown: boolean): AudioBuffer {
  const length = Math.floor(context.sampleRate * NOISE_SECONDS)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    if (brown) {
      // Leaky integrator: -6 dB/octave, the deep rumble of water.
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    } else {
      data[i] = white
    }
  }
  // Cross-fade the loop point so it does not click.
  const fade = Math.floor(context.sampleRate * 0.25)
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    data[i] *= t
    data[length - 1 - i] *= t
  }
  return buffer
}

/**
 * The sea: brown noise through a low-pass, with a slow amplitude swell so it
 * breathes like water rather than humming like a fan.
 */
function buildSea(context: AudioContext, out: GainNode): void {
  const source = context.createBufferSource()
  source.buffer = noiseBuffer(context, true)
  source.loop = true

  const filter = context.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 420
  filter.Q.value = 0.4

  const swell = context.createGain()
  swell.gain.value = 0.5

  // Two out-of-phase slow LFOs on the gain: one long swell, one shorter lap.
  const lfo = context.createOscillator()
  lfo.frequency.value = 0.07
  const lfoGain = context.createGain()
  lfoGain.gain.value = 0.22
  lfo.connect(lfoGain).connect(swell.gain)

  const lap = context.createOscillator()
  lap.frequency.value = 0.21
  const lapGain = context.createGain()
  lapGain.gain.value = 0.1
  lap.connect(lapGain).connect(swell.gain)

  source.connect(filter).connect(swell).connect(out)
  source.start()
  lfo.start()
  lap.start()
}

/** Wind: white noise through a band-pass that wanders, returned so it can be driven. */
function buildWind(context: AudioContext, out: GainNode): GainNode {
  const source = context.createBufferSource()
  source.buffer = noiseBuffer(context, false)
  source.loop = true

  const filter = context.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 700
  filter.Q.value = 0.9

  // The filter centre drifts so the wind has a voice rather than a hiss.
  const drift = context.createOscillator()
  drift.frequency.value = 0.05
  const driftGain = context.createGain()
  driftGain.gain.value = 260
  drift.connect(driftGain).connect(filter.frequency)

  const gain = context.createGain()
  gain.gain.value = 0.2

  source.connect(filter).connect(gain).connect(out)
  source.start()
  drift.start()
  return gain
}

/**
 * One bell. A fundamental with two quiet inharmonic partials, a fast attack
 * and a long decay, pitched in the warm middle of the keyboard. Not a
 * notification sound: no rising interval, nothing that asks for attention.
 */
function bell(context: AudioContext, out: GainNode, volume: number): void {
  const now = context.currentTime
  const partials: Array<[number, number, number]> = [
    // frequency, relative gain, decay seconds
    [523.25, 1.0, 2.6],
    [523.25 * 2.41, 0.28, 1.4],
    [523.25 * 3.9, 0.12, 0.9],
  ]
  for (const [frequency, level, decay] of partials) {
    const osc = context.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = frequency
    const gain = context.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.16 * level * (0.4 + volume * 0.6), now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0008, now + decay)
    osc.connect(gain).connect(out)
    osc.start(now)
    osc.stop(now + decay + 0.05)
  }
}
