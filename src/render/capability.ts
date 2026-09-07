import { devOverrides, type QualityTier } from '@/core/config'

export type RenderPath = 'webgpu' | 'webgl2' | 'none'

export interface Capability {
  path: RenderPath
  /** Reported adapter description, when the platform will tell us. */
  adapter: string
  maxTextureSize: number
  /** True when renderer.compute() is usable. WebGL2 has no compute shaders. */
  hasCompute: boolean
  suggestedTier: QualityTier
  /** Why we ended up on this path - surfaced in the HUD, and worth reading. */
  reason: string
}

/**
 * Runtime render-path detection.
 *
 * The WebGL2 fallback is not optional: this ships as a desktop and mobile
 * binary and system WebViews vary wildly in WebGPU support. The important
 * consequence, and the one that shapes the whole renderer, is that WebGL2 has
 * no compute shaders at all. Three's TSL falls back for *materials*, but
 * renderer.compute() requires the WebGPU backend - so every compute workload
 * needs a declared CPU or vertex-stage strategy for this path rather than a
 * second shader nobody maintains.
 */
export async function detectCapability(): Promise<Capability> {
  const webgl2 = probeWebGL2()

  // `?path=webgl2` (development only) forces the fallback on a machine that
  // has WebGPU, which is how the two backends are compared on the same GPU.
  if (devOverrides().path !== 'webgl2' && typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (adapter) {
        const info = adapter.info
        const name = [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' ') || 'WebGPU adapter'
        return {
          path: 'webgpu',
          adapter: name.trim(),
          maxTextureSize: adapter.limits.maxTextureDimension2D ?? 8192,
          hasCompute: true,
          suggestedTier: tierForAdapter(info, true),
          reason: 'WebGPU adapter available; compute workloads run on the GPU.',
        }
      }
    } catch {
      // Fall through to WebGL2. A thrown adapter request is a normal outcome
      // on machines with a blocklisted driver.
    }
  }

  if (webgl2.ok) {
    return {
      path: 'webgl2',
      adapter: webgl2.renderer,
      maxTextureSize: webgl2.maxTextureSize,
      hasCompute: false,
      suggestedTier: 'medium',
      reason: 'No WebGPU adapter. Falling back to WebGL2; simulation runs on the CPU in a worker at reduced counts.',
    }
  }

  return {
    path: 'none',
    adapter: 'unknown',
    maxTextureSize: 0,
    hasCompute: false,
    suggestedTier: 'low',
    reason: 'Neither WebGPU nor WebGL2 is available. The workspace half remains fully usable.',
  }
}

function probeWebGL2(): { ok: boolean; renderer: string; maxTextureSize: number } {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return { ok: false, renderer: '', maxTextureSize: 0 }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const lose = gl.getExtension('WEBGL_lose_context')
    lose?.loseContext()
    return { ok: true, renderer, maxTextureSize }
  } catch {
    return { ok: false, renderer: '', maxTextureSize: 0 }
  }
}

export interface AdapterInfoLike {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
}

/**
 * A starting tier from what the adapter says about itself.
 *
 * The first version read `maxComputeWorkgroupStorageSize`, which is 32 KB on
 * practically everything made this decade, and so told an Intel Iris Xe it was
 * High. Measured on that GPU, High presented a frame every 92 ms. Vendor and
 * architecture are the only performance signal an adapter offers before
 * anything is drawn: Intel is integrated unless it is Arc (`xe-hpg`), the
 * mobile vendors get Low because Low must run on a phone, and the first-run
 * frame benchmark in `core/autoQuality.ts` corrects downward from here with
 * a measurement rather than a guess.
 */
export function tierForAdapter(info: AdapterInfoLike | undefined, hasCompute: boolean): QualityTier {
  if (!hasCompute) return 'medium'
  const vendor = (info?.vendor ?? '').toLowerCase()
  const arch = (info?.architecture ?? '').toLowerCase()
  if (vendor === 'intel') return arch.includes('hpg') ? 'high' : 'medium'
  if (vendor === 'apple' || vendor === 'nvidia' || vendor === 'amd') return 'high'
  if (vendor === 'qualcomm' || vendor === 'arm' || vendor === 'samsung' || vendor === 'imgtec' || vendor === 'img') return 'low'
  return 'medium'
}
