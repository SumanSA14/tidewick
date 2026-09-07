import { useEffect, useRef } from 'react'
import type { StageMetrics } from '@/render/stage'
import { SIM_HZ } from '@/core/config'

/**
 * The performance HUD, built in Phase 1 rather than at the end.
 *
 * The brief is emphatic about this and it is right: you use this every single
 * day, it is the only way to tell an optimisation from a superstition, and it
 * is the best asset in a demo video. Building it last means every earlier
 * performance decision was a guess.
 *
 * The two numbers that matter most are the CPU/GPU split - because the budget
 * says the CPU must never be the bottleneck - and the active render path,
 * because almost every surprising measurement in this project turns out to be
 * the WebGL2 fallback quietly doing the work on a worker thread.
 */

const GRAPH_WIDTH = 168
const GRAPH_HEIGHT = 40
const HISTORY = GRAPH_WIDTH
const TARGET_MS = 1000 / 60

export interface PerfHUDProps {
  metrics: StageMetrics | null
  visible: boolean
  outlineEnabled: boolean
  outlineAvailable: boolean
  onToggleOutline(next: boolean): void
}

export function PerfHUD({ metrics, visible, outlineEnabled, outlineAvailable, onToggleOutline }: PerfHUDProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const history = useRef<number[]>([])

  useEffect(() => {
    if (!metrics) return
    const h = history.current
    h.push(metrics.frameMs)
    if (h.length > HISTORY) h.shift()

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio, 2)
    if (canvas.width !== GRAPH_WIDTH * dpr) {
      canvas.width = GRAPH_WIDTH * dpr
      canvas.height = GRAPH_HEIGHT * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT)

    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.fillRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT)

    // The 60 fps line. Everything is read relative to this.
    const scale = GRAPH_HEIGHT / (TARGET_MS * 2.5)
    const targetY = GRAPH_HEIGHT - TARGET_MS * scale
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(0, targetY)
    ctx.lineTo(GRAPH_WIDTH, targetY)
    ctx.stroke()
    ctx.setLineDash([])

    for (let i = 0; i < h.length; i++) {
      const ms = h[i]
      const barHeight = Math.min(GRAPH_HEIGHT, ms * scale)
      ctx.fillStyle = ms <= TARGET_MS ? 'rgba(96,214,204,0.95)' : 'rgba(232,178,94,0.95)'
      ctx.fillRect(i, GRAPH_HEIGHT - barHeight, 1, barHeight)
    }
  }, [metrics])

  if (!visible) return null

  const t = metrics?.terrain ?? null

  return (
    <aside className="hud" aria-label="Performance overlay" aria-live="off">
      <header className="hud__title">
        <span>tidewick</span>
        <kbd>F3</kbd>
      </header>

      <canvas
        ref={canvasRef}
        className="hud__graph"
        style={{ width: GRAPH_WIDTH, height: GRAPH_HEIGHT }}
        aria-hidden="true"
      />

      {metrics ? (
        <>
          <Row label="fps" value={metrics.fps.toFixed(0)} emphasis={metrics.fps < 55} />
          <Row label="frame" value={`${metrics.frameMs.toFixed(2)} ms`} />
          <Row label="cpu" value={`${metrics.cpuMs.toFixed(2)} ms`} emphasis={metrics.cpuMs > 4} />
          <Row label="gpu" value={metrics.gpuMs > 0 ? `${metrics.gpuMs.toFixed(2)} ms` : 'n/a'} />
          <Row label="draw calls" value={String(metrics.drawCalls)} emphasis={metrics.drawCalls >= 200} />
          <Row label="triangles" value={fmt(metrics.triangles)} />
          <Row label="buffers" value={`${metrics.bufferMemoryMB.toFixed(1)} MB`} />
          <Row label="sim" value={`${SIM_HZ} Hz / ${metrics.simSteps} step${metrics.simSteps === 1 ? '' : 's'}`} />

          <hr className="hud__rule" />
          <Row label="plants" value={fmt(metrics.plants)} />
          <Row label="agents" value={fmt(metrics.agents)} />
          <Row label="grass" value={metrics.grassBlades > 0 ? fmt(metrics.grassBlades) : 'off'} />
          <Row label="derive" value={metrics.deriveMs > 0 ? `${metrics.deriveMs.toFixed(1)} ms` : '-'} emphasis={metrics.deriveMs > 16} />
          <Row
            label="last upload"
            value={metrics.uploadInstances > 0 ? `${metrics.uploadBytes} B / ${metrics.uploadInstances}` : 'idle'}
          />

          <hr className="hud__rule" />
          <Row label="path" value={metrics.path === 'webgpu' ? 'WebGPU' : 'WebGL2 (fallback)'} emphasis={metrics.path === 'webgl2'} />
          <Row label="adapter" value={metrics.adapter} small />
          <Row label="tier" value={metrics.tier} />
          <Row label="internal" value={`${metrics.width}×${metrics.height}${metrics.renderScale < 1 ? ` (${Math.round(metrics.renderScale * 100)}%)` : ''}`} emphasis={metrics.renderScale < 1} />
          <Row label="terrain verts" value={fmt(metrics.terrainVertices)} />

          {t && (
            <>
              <hr className="hud__rule" />
              <Row label="erosion" value={`${t.erosionMs.toFixed(0)} ms (${t.erosionBackend})`} />
              <Row label="base gen" value={`${t.baseMs.toFixed(0)} ms`} />
              <Row label="terrace" value={`${t.terraceMs.toFixed(0)} ms`} />
              <Row label="mesh" value={`${t.meshMs.toFixed(0)} ms`} />
              <Row label="total" value={`${t.totalMs.toFixed(0)} ms`} emphasis={t.totalMs > 400} />
            </>
          )}
        </>
      ) : (
        <p className="hud__pending">waiting for first frame</p>
      )}

      <hr className="hud__rule" />
      <label className="hud__toggle">
        <input
          type="checkbox"
          checked={outlineEnabled}
          disabled={!outlineAvailable}
          onChange={(e) => onToggleOutline(e.target.checked)}
        />
        <span>ink outlines{outlineAvailable ? '' : ' (unavailable)'}</span>
      </label>
    </aside>
  )
}

function Row({ label, value, emphasis, small }: { label: string; value: string; emphasis?: boolean; small?: boolean }) {
  return (
    <div className={`hud__row${emphasis ? ' hud__row--warn' : ''}${small ? ' hud__row--small' : ''}`}>
      <span className="hud__label">{label}</span>
      <span className="hud__value">{value}</span>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
