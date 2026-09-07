import {
  Scene, BufferGeometry, BufferAttribute, Mesh, Group, Raycaster,
  Vector2, Vector3, PerspectiveCamera,
  DirectionalLight, HemisphereLight, PCFSoftShadowMap, FrontSide, TimestampQuery,
} from 'three'
import { WebGPURenderer, MeshToonNodeMaterial } from 'three/webgpu'
import { TERRAIN, MAX_FRAME_MS, type QualityTier, budgetFor, devOverrides, type TierBudget} from '@/core/config'
import { FixedLoop, type FrameTiming } from '@/core/loop'
import { terrainSeed } from '@/core/hash'
import { DioramaCamera } from './camera/diorama'
import { makeToonRamp, TERRAIN_RAMP_STOPS } from './materials/toonRamp'
import { seasonAt, blendSeasons, type SeasonPalette } from './palette'
import { createOutlinePost, DEFAULT_OUTLINE, type OutlinePost } from './passes/outline'
import { createSky, type Sky } from './sky'
import { createOcean, type Ocean } from './ocean'
import { createPlants, PLANT_HALF_HEIGHT, PLANT_PICK_RADIUS, type Plants } from './plants'
import { createFootpaths, type Footpaths } from './footpaths'
import { buildRadialProfile, sampleProfile, type RadialProfile } from './terrain/profile'
import { applyGoldenHour } from '@/loop/goldenHour'
import { FollowCamera } from './camera/follow'
import { KeeperView, type KeeperDressing } from './keeper'
import { createGrass, type Grass } from './grass'
import { createBirds, type Birds } from './birds'
import { setMotionScale, agentsFor } from './motion'
import { prefersReducedMotion, onReducedMotionChange } from '@/core/reducedMotion'
import { createGroundSampler } from '@/keeper/ground'
import type { GroundSampler } from '@/keeper/controller'
import { KeeperSystem } from '@/keeper/system'
import { KeeperInputSource } from '@/keeper/input'
import type { TerracedField } from './terrain/terrace'
import { diffSnapshots, writeRange, FLOATS_PER_INSTANCE, type BridgeDiff } from '@/island/bridge'
import { newlyLit, bloomStage, bloomFinished, type Bloom } from '@/island/blooms'
import { elevationFor, EMPTY_SNAPSHOT, OVERDUE_FLOOR, type IslandSnapshot } from '@/island/derive'
import type { WorkspaceState } from '@/state/types'
import type { DeriveRequest, DeriveResponse } from '@/workers/deriveProtocol'
import { daylightAt, daylightAtHour, type DaylightState } from '@/core/daylight'
import type { Capability } from './capability'
import type {
  TerrainRequest, TerrainResponse, TerrainShape, TerrainTimings, WorkerResponse, WarmRequest,
} from '@/workers/terrainProtocol'

/**
 * Which camera is driving.
 *
 * The diorama is not retired when the Keeper arrives - it remains the best
 * overview of the whole island and the best screenshot, so it stays a toggle.
 */
export type CameraMode = 'diorama' | 'keeper'

export interface StageOptions {
  /** Internal resolution as a fraction of the display's, 0.5-1. See `setRenderScale`. */
  renderScale?: number
}

function clampScale(scale: number): number {
  return Number.isFinite(scale) ? Math.min(1, Math.max(0.5, scale)) : 1
}

/** What `benchmarkFrames` reports. Every field is measured, none inferred. */
export interface FrameBenchmark {
  frames: number
  medianFrameMs: number
  p95FrameMs: number
  medianCpuMs: number
  p95CpuMs: number
  /** Null when the backend gives no GPU timestamps, rather than a fake zero. */
  gpuMs: number | null
  drawCalls: number
  triangles: number
  width: number
  height: number
  path: 'webgpu' | 'webgl2'
  tier: QualityTier
}

/**
 * What `benchmarkSubmit` reports. Submit is the CPU's share of a frame;
 * serialised is CPU plus GPU with no overlap, an upper bound on the frame.
 */
export interface SubmitBenchmark {
  frames: number
  medianSubmitMs: number
  p95SubmitMs: number
  medianSerialisedMs: number | null
  p95SerialisedMs: number | null
  drawCalls: number
  triangles: number
  width: number
  height: number
  path: 'webgpu' | 'webgl2'
  tier: QualityTier
}

export interface StageMetrics {
  fps: number
  frameMs: number
  cpuMs: number
  gpuMs: number
  drawCalls: number
  triangles: number
  bufferMemoryMB: number
  simSteps: number
  path: 'webgpu' | 'webgl2'
  adapter: string
  tier: QualityTier
  terrainVertices: number
  terrain: TerrainTimings | null
  /** Plants currently on the isle. */
  plants: number
  /** Flocking agents alive this frame. */
  agents: number
  /** Grass blades placed; zero on Low, where there is no grass. */
  grassBlades: number
  /** Drawing-buffer size actually rendered, and the scale that produced it. */
  width: number
  height: number
  renderScale: number
  /** Milliseconds the last derive() took, off-thread. */
  deriveMs: number
  /** Bytes the last island update actually sent to the GPU. */
  uploadBytes: number
  /** Instances the last island update touched. */
  uploadInstances: number
}

/** How often the world re-reads the wall clock. Once a second is plenty. */
const DAYLIGHT_INTERVAL_SECONDS = 1

/** Ocean surface sits just below the waterline so the beach reads as beach. */
const OCEAN_Y = -0.35

export class Stage {
  readonly scene = new Scene()
  readonly renderer: WebGPURenderer
  readonly diorama: DioramaCamera

  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly loop: FixedLoop
  private readonly terrainGroup = new Group()
  private worker: Worker | null = null
  /** Bumped per regeneration so a late reply for an old seed is ignored. */
  private terrainSeq = 0
  private outline: OutlinePost | null = null
  private outlineEnabled = true
  private season: SeasonPalette
  private capability: Capability
  private tier: QualityTier

  private sky: Sky | null = null
  private sun: DirectionalLight | null = null
  private hemi: HemisphereLight | null = null
  private ocean: Ocean | null = null
  private daylight: DaylightState = daylightAt()
  /** The hour as it really is, before golden hour bends it. */
  private baseDaylight: DaylightState = daylightAt()
  private goldenDepth = 0
  private seasonBlendT = 0
  /** Plants mid bloom-and-lantern. Presentation only - see blooms.ts. */
  private blooms: Bloom[] = []
  /** Seconds since the Stage started. Small, so float32 keeps its precision. */
  private elapsed = 0
  private daylightTimer = 0
  private pinnedHour: number | null = null
  private plants: Plants | null = null
  private footpaths: Footpaths | null = null
  private grass: Grass | null = null
  private birds: Birds | null = null
  private stopMotionWatch: (() => void) | null = null
  private readonly timingListeners = new Set<(t: FrameTiming) => void>()
  /** The tier's budget, with development overrides applied once at construction. */
  private readonly budget: TierBudget
  private renderScale = 1
  /** A ?scale= development override pins the scale against the settings effect. */
  private scaleLocked = false
  /** Terrain heights for anything that needs the floor: birds, the Keeper. */
  private ground: GroundSampler | null = null
  private profile: RadialProfile | null = null
  private deriveWorker: Worker | null = null
  private deriveSeq = 0
  private snapshot: IslandSnapshot = EMPTY_SNAPSHOT
  private instanceData: Float32Array | null = null
  private lastDeriveMs = 0
  private lastDiff: BridgeDiff = { ranges: [], resized: false, changed: 0, bytes: 0 }
  /** Retained so the Keeper can ask the ground where the floor is. */
  private terraced: TerracedField | null = null
  private follow: FollowCamera | null = null
  private keeper: KeeperSystem | null = null
  private keeperView: KeeperView | null = null
  private keeperInput: KeeperInputSource | null = null
  private cameraMode: CameraMode = 'diorama'
  /** The player's chosen colours, kept until the Keeper exists to wear them. */
  private dressing: Partial<KeeperDressing> = {}

  private readonly raycaster = new Raycaster()
  private readonly pickPoint = new Vector3()
  private lastTerrainTimings: TerrainTimings | null = null
  private terrainVertices = 0
  private fpsWindow: number[] = []
  private resizeObserver: ResizeObserver | null = null
  private disposed = false

  onMetrics: ((m: StageMetrics) => void) | null = null
  onTerrainReady: ((t: TerrainResponse) => void) | null = null
  onIslandReady: ((s: IslandSnapshot) => void) | null = null
  onCameraMode: ((mode: CameraMode) => void) | null = null

  private constructor(container: HTMLElement, renderer: WebGPURenderer, capability: Capability) {
    this.container = container
    this.renderer = renderer
    this.canvas = renderer.domElement as HTMLCanvasElement
    this.capability = capability
    this.tier = capability.suggestedTier
    this.budget = budgetFor(this.tier)
    this.season = seasonAt(0)

    const rect = container.getBoundingClientRect()
    this.diorama = new DioramaCamera(this.canvas, Math.max(0.1, rect.width / Math.max(1, rect.height)))

    this.loop = new FixedLoop({
      fixedUpdate: (dt) => {
        // Advance the world clock. Everything else that will eventually live
        // here - drift, growth, the focus timer - runs on this same fixed step,
        // which is why it exists before there is anything to step.
        this.daylightTimer += dt
        if (this.daylightTimer >= DAYLIGHT_INTERVAL_SECONDS && this.pinnedHour === null) {
          this.daylightTimer = 0
          this.applyDaylight(daylightAt())
        }
        // The plants read the clock directly, so downhill drift is continuous
        // rather than a simulation step. This one line is the entire drift
        // mechanic: a task descends because time moved, not because anything
        // simulated it.
        this.plants?.setNow(Date.now())
        this.birds?.step(dt, this.ground)

        this.elapsed += dt
        if (this.blooms.length > 0) this.advanceBlooms()

        // The Keeper runs on the same fixed step as everything else, so
        // movement is frame-rate independent and reproducible.
        if (this.cameraMode === 'keeper' && this.keeper && this.follow && this.keeperInput) {
          this.keeper.fixedUpdate(this.keeperInput.sample(this.follow.yaw), dt)
        }
      },
      render: (_alpha, dt) => this.renderFrame(dt),
    })
    // One fixed hook that fans out. `benchmarkFrames` used to replace the
    // hook and restore its predecessor when done; two concurrent callers then
    // clobbered each other and the loser never resolved. Now each caller adds
    // a listener and removes only itself.
    this.loop.onTiming = (t) => {
      this.publishMetrics(t)
      for (const listener of this.timingListeners) listener(t)
    }
  }

  static async create(container: HTMLElement, capability: Capability, options: StageOptions = {}): Promise<Stage> {
    const canvas = document.createElement('canvas')
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', 'The isle. Drag to orbit, scroll to zoom, arrow keys to look around.')
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none;'
    container.appendChild(canvas)

    // Spawn the terrain worker now and warm its JIT while the renderer
    // initialises. The two have nothing to do with each other, and renderer
    // init is the one long idle stretch at boot where a warm-up costs nothing.
    const worker = new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' })
    worker.postMessage({ type: 'warm' } satisfies WarmRequest)

    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      // Honour the detected path. Forcing WebGL2 here is also how we test the
      // fallback on a machine that has perfectly good WebGPU.
      forceWebGL: capability.path === 'webgl2',
      // Timestamp queries give the HUD a real GPU number instead of an
      // inference drawn from frame time. Constructor-only, not a setter.
      trackTimestamp: true,
    })
    const devScale = Number(devOverrides().scale)
    const renderScale = clampScale(Number.isFinite(devScale) && devScale > 0 ? devScale : options.renderScale ?? 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFSoftShadowMap

    await renderer.init()

    const stage = new Stage(container, renderer, capability)
    stage.renderScale = renderScale
    stage.scaleLocked = Number.isFinite(devScale) && devScale > 0
    stage.worker = worker
    stage.buildWorld()
    // Reduced motion, honoured live: the idle clock (grass, swell, twinkle,
    // cloud drift) stops, and restarts if the preference changes while the
    // isle is open. Camera drift is handled by the cameras themselves.
    setMotionScale(prefersReducedMotion() ? 0 : 1)
    stage.stopMotionWatch = onReducedMotionChange((reduced) => setMotionScale(reduced ? 0 : 1))
    stage.attachResize()
    stage.buildOutline()
    stage.loop.start()
    return stage
  }

  /** True backend after init, which may differ from what detection guessed. */
  get activePath(): 'webgpu' | 'webgl2' {
    const backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
    return backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'
  }

  private buildWorld(): void {
    this.scene.add(this.terrainGroup)

    // Sky, sun and sea all read from one daylight state, so they can never
    // disagree about what time it is - a surprisingly easy bug to write when
    // each is tuned by hand.
    this.sky = createSky()
    this.scene.add(this.sky.mesh)

    const sun = new DirectionalLight(0xffffff, 2.15)
    sun.castShadow = true
    sun.shadow.mapSize.setScalar(this.budget.shadowSize)
    const half = TERRAIN.worldSize * 0.62
    sun.shadow.camera.left = -half
    sun.shadow.camera.right = half
    sun.shadow.camera.top = half
    sun.shadow.camera.bottom = -half
    sun.shadow.camera.near = 20
    sun.shadow.camera.far = 520
    // Soft and forgiving on purpose. Nothing here is allowed to look harsh,
    // and a crisp shadow terminator across a grass plateau does.
    sun.shadow.radius = 5
    sun.shadow.bias = -0.0004
    // Terraces are flat-shaded with hard normals and near-vertical cliff faces,
    // which is the worst case for depth-only bias: it produces speckled acne on
    // the plateau tops. Offsetting along the normal instead fixes it without
    // the peter-panning a larger depth bias would cause.
    sun.shadow.normalBias = 0.6
    sun.name = 'sun'
    this.sun = sun
    this.scene.add(sun)

    const hemi = new HemisphereLight(0xffffff, 0xffffff, 1.05)
    hemi.name = 'hemi'
    this.hemi = hemi
    this.scene.add(hemi)

    this.ocean = createOcean(TERRAIN.worldSize, OCEAN_Y)
    this.scene.add(this.ocean.mesh)

    this.plants = createPlants()
    this.plants.setNow(Date.now())
    this.scene.add(this.plants.mesh)

    this.footpaths = createFootpaths()
    this.footpaths.setTint(this.season.foam)
    this.scene.add(this.footpaths.line)

    // Scenery, not state. Grass and birds read nothing from the workspace;
    // they exist so the island is a place rather than a chart. Both are sized
    // by the quality tier and both are honest about the path they run on.
    this.grass = createGrass()
    this.scene.add(this.grass.mesh)

    // Reduced motion thins the flock; the birds that remain still fly.
    this.birds = createBirds(agentsFor(this.budget.agents, prefersReducedMotion()), 0x5eed)
    this.scene.add(this.birds.mesh)

    this.applyDaylight(this.daylight)
  }

  /**
   * Push a daylight state through the sky, the sun, the bounce light and the
   * sea. The season palette still decides the *character* of the water; the
   * clock decides how brightly it is lit. Multiplying rather than replacing
   * keeps a summer sea recognisably summer at dusk.
   */
  /**
   * How deep into golden hour the isle is, 0..1.
   *
   * Set by the focus session. Kept separate from the daylight state so the two
   * can be recomputed independently - the clock ticks on its own schedule and
   * the session on another.
   */
  /**
   * Set the season, optionally part-way into the fade to the next one.
   *
   * The workspace owns `seasonIndex`; this is the island reading it. Passing
   * the blend separately rather than an already-mixed palette keeps the fade
   * curve in one place - `seasonBlend` in the loop module - instead of half
   * here and half there.
   */
  setSeason(index: number, blend = 0): void {
    const next = blend > 0
      ? blendSeasons(index, index + 1, blend)
      : seasonAt(index)
    if (next.id === this.season.id && Math.abs(blend - this.seasonBlendT) < 0.004) return

    this.season = next
    this.seasonBlendT = blend
    this.footpaths?.setTint(next.foam)
    this.outline?.setOutlineColor(next.outline)
    this.birds?.setTint(next.outline)
    // Re-light: the palette decides the character of sky and sea, the clock
    // decides how brightly they are lit, so the fade has to run back through
    // the same path rather than setting colours directly.
    this.applyDaylight(this.baseDaylight)
  }

  setGoldenHour(depth: number): void {
    const next = Math.max(0, Math.min(1, depth))
    if (Math.abs(next - this.goldenDepth) < 0.002) return
    this.goldenDepth = next
    this.applyDaylight(this.baseDaylight)
  }

  private applyDaylight(base: DaylightState): void {
    this.baseDaylight = base
    const state = this.goldenDepth > 0 ? applyGoldenHour(base, this.goldenDepth) : base
    this.daylight = state
    this.sky?.apply(state)
    // Scenery lit by the same clock as everything else.
    this.grass?.setLight(0.5 + state.daylight * 0.5)
    this.birds?.setLight(state.daylight)
    this.plants?.setDaylight(state.daylight)

    if (this.sun) {
      const d = state.sunDirection
      const distance = 260
      this.sun.position.set(d.x * distance, d.y * distance, d.z * distance)
      this.sun.color.setRGB(state.sun.r, state.sun.g, state.sun.b)
      this.sun.intensity = state.sunIntensity
    }

    if (this.hemi) {
      this.hemi.color.setRGB(state.skyTop.r, state.skyTop.g, state.skyTop.b)
      this.hemi.groundColor.setRGB(state.ambient.r, state.ambient.g, state.ambient.b)
      this.hemi.intensity = state.ambientIntensity
    }

    const season = this.season
    this.ocean?.apply(state, season.water, season.waterDeep, season.foam)
    this.syncRays()
  }

  /**
   * God-rays follow the sun. They carry its colour, fade in over the first
   * few degrees above the horizon so a sun below the sea streams nothing, and
   * are gated on the daylight so the deep-night sky stays dark even where the
   * clamped solar arc keeps the direction shallow.
   */
  private syncRays(): void {
    if (!this.outline?.godraysEnabled) return
    const state = this.daylight
    const budget = this.budget.godrays
    const above = Math.min(1, Math.max(0, state.sunDirection.y / 0.12))
    const day = Math.min(1, Math.max(0, (state.daylight - 0.05) / 0.3))
    this.outline.setGodrays(budget * above * day)
    this.outline.setSunColor(state.sun.r, state.sun.g, state.sun.b)
  }

  /**
   * Push a workspace change to the island.
   *
   * Derivation happens on a worker; the reply is diffed against the previous
   * snapshot and only the changed instance ranges are uploaded. Ticking a
   * to-do therefore sends a few dozen bytes rather than the whole buffer,
   * which is what keeps a workspace change inside one frame.
   */
  updateWorld(state: WorkspaceState): void {
    if (!this.deriveWorker) {
      this.deriveWorker = new Worker(new URL('../workers/derive.worker.ts', import.meta.url), { type: 'module' })
      this.deriveWorker.onmessage = (e: MessageEvent<DeriveResponse>) => this.applySnapshot(e.data)
    }
    const request: DeriveRequest = { type: 'derive', seq: ++this.deriveSeq, state }
    this.deriveWorker.postMessage(request)
  }

  private applySnapshot(response: DeriveResponse): void {
    // A reply for a superseded request is stale by definition, and dropping it
    // is safe precisely because derive() is pure and holds nothing.
    if (response.seq !== this.deriveSeq) return

    const next = response.snapshot
    const diff = diffSnapshots(this.snapshot, next)
    this.lastDeriveMs = response.elapsedMs
    this.lastDiff = diff

    if (diff.resized || !this.instanceData) {
      this.instanceData = this.plants?.resize(next.count) ?? null
    }
    if (this.instanceData && this.plants) {
      for (const range of diff.ranges) writeRange(this.instanceData, next, range)
      this.plants.markDirty(diff.ranges)
    }

    // Detect completions *before* the previous snapshot is replaced. The
    // snapshot states that a task is done; the bloom is this layer noticing
    // that it just became so.
    const lit = newlyLit(this.snapshot, next, this.elapsed)
    if (lit.length > 0) {
      // A plant already blooming that is completed again keeps its original
      // start rather than restarting - undo/redo should not re-celebrate.
      for (const bloom of lit) {
        if (!this.blooms.some((b) => b.index === bloom.index)) this.blooms.push(bloom)
      }
    }

    this.snapshot = next
    // Paths are rebuilt on snapshot change rather than per frame: a link is
    // created once and then sits there, unlike a plant, which drifts every
    // second. See footpaths.ts for why they are not placed in a shader.
    if (this.profile) this.footpaths?.rebuild(next, this.profile, Date.now())
    this.keeper?.setSnapshot(next)
    this.onIslandReady?.(next)
  }

  /**
   * What was clicked, as a page id.
   *
   * A CPU pick against the same maths the shader uses, rather than a GPU
   * readback. Positions are a pure function of angle, due date, now and the
   * profile, so both sides compute them and agree - and a readback costs a
   * pipeline stall on click, which is the one moment a user is watching.
   */
  pick(clientX: number, clientY: number): string | null {
    if (!this.profile || this.snapshot.count === 0) return null

    const rect = this.canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.activeCamera)

    const now = Date.now()
    let bestId: string | null = null
    let bestDistance = Infinity

    for (let i = 0; i < this.snapshot.count; i++) {
      const level = elevationFor(this.snapshot.due[i], now)
      const sampled = sampleProfile(this.profile, this.snapshot.angle[i], Math.max(0, level))
      const jitter = this.snapshot.jitter[i]
      const angle = this.snapshot.angle[i] + (jitter - 0.5) * 0.16
      const radius = sampled.radius * (1 - jitter * 0.10)
      const submerged = Math.max(0, Math.min(1, -level / -OVERDUE_FLOOR))
      const y = sampled.height * (1 - submerged) + -1.1 * submerged

      this.pickPoint.set(Math.cos(angle) * radius, y + PLANT_HALF_HEIGHT, Math.sin(angle) * radius)
      // Generous radius: plants are small on screen at diorama distance, and a
      // pick that needs pixel accuracy is a pick nobody lands.
      if (this.raycaster.ray.distanceToPoint(this.pickPoint) > PLANT_PICK_RADIUS * this.snapshot.scale[i]) continue

      const along = this.raycaster.ray.origin.distanceTo(this.pickPoint)
      if (along < bestDistance) {
        bestDistance = along
        bestId = this.snapshot.ids[i]
      }
    }

    return bestId
  }

  get islandSnapshot(): IslandSnapshot {
    return this.snapshot
  }

  /** Current world clock, for the home page and the HUD. */
  get daylightState(): DaylightState {
    return this.daylight
  }

  /**
   * Pin the world clock to a given hour, or release it back to real time.
   *
   * Art direction needs this: judging dusk by waiting for dusk is not a
   * workflow. Dev-only in practice, but it lives on Stage rather than in the
   * dev bundle because Phase 7's focus sessions need the same lever to sweep
   * the isle into golden hour on demand.
   */
  /**
   * The Keeper, created on first use.
   *
   * Lazily, because Phases 1 through 5 are a complete product without a
   * character in them and the diorama build should not pay for one. It also
   * means the meshes, the input listeners and the follow camera only exist
   * once someone actually walks the isle.
   */
  private ensureKeeper(): KeeperSystem {
    if (this.keeper) return this.keeper

    this.keeper = new KeeperSystem()
    this.keeperView = new KeeperView()
    this.keeperView.dress(this.dressing)
    this.scene.add(this.keeperView.group)

    const rect = this.container.getBoundingClientRect()
    this.follow = new FollowCamera(this.canvas, Math.max(0.1, rect.width / Math.max(1, rect.height)))

    this.keeperInput = new KeeperInputSource(this.canvas)
    this.keeperInput.onInteract = () => this.keeper?.interact()
    this.keeperInput.onOverview = () => {
      this.setCameraMode(this.cameraMode === 'keeper' ? 'diorama' : 'keeper')
    }

    if (this.terraced) {
      this.keeper.setField(this.terraced)
      this.keeper.setProfile(this.profile)
    }
    this.keeper.setSnapshot(this.snapshot)
    return this.keeper
  }

  /** The Keeper's intents and status, for the app to wire commands onto. */
  get keeperSystem(): KeeperSystem {
    return this.ensureKeeper()
  }

  get mode(): CameraMode {
    return this.cameraMode
  }

  /** The tier this Stage was built at. Fixed for its lifetime. */
  get qualityTier(): QualityTier {
    return this.tier
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return

    if (mode === 'keeper') {
      const keeper = this.ensureKeeper()
      // Come in facing the way the diorama was looking, so the handover does
      // not spin the world.
      const camera = this.diorama.camera
      this.follow?.faceFrom(
        camera.position.x - keeper.state.x,
        camera.position.z - keeper.state.z,
      )
      this.keeperView?.setVisible(true)
    } else {
      this.keeperView?.setVisible(false)
      // Release every held key: they were pressed for a camera that is no
      // longer driving, and would otherwise still be held on the way back.
      this.keeperInput?.setSuspended(true)
      this.keeperInput?.setSuspended(false)
    }

    this.cameraMode = mode
    this.onCameraMode?.(mode)
  }

  /**
   * Dress the Keeper in the colours from `meta.keeper`.
   *
   * Safe to call before the Keeper exists - the colours are held and worn on
   * first creation - so the app can push them whenever the workspace changes
   * without caring whether anyone has walked the isle yet.
   */
  setKeeperColours(colours: Partial<KeeperDressing>): void {
    this.dressing = { ...this.dressing, ...colours }
    this.keeperView?.dress(this.dressing)
  }

  /** Cloud cover, 0..1. Weather is cosmetic (Section 3.5); this is the knob. */
  setCloudCover(cover: number): void {
    this.sky?.setCloudCover(cover)
  }

  /** Stop the Keeper responding to keys while the workspace UI has focus. */
  setInputSuspended(suspended: boolean): void {
    this.keeperInput?.setSuspended(suspended)
  }

  pinHour(hour: number | null): void {
    this.pinnedHour = hour
    this.applyDaylight(hour === null ? daylightAt() : daylightAtHour(hour))
  }

  private buildOutline(): void {
    try {
      this.outline = createOutlinePost(this.renderer, this.scene, this.diorama.camera, this.season.outline, {
        ...DEFAULT_OUTLINE,
        bloom: this.budget.bloom,
        godrays: this.budget.godrays,
        normals: this.budget.outlineNormals,
      }, this.sun)
      // Daylight was applied while the world was built, before this pass
      // existed: push the sun into the rays now rather than on the next tick.
      this.syncRays()
    } catch (err) {
      // An outline pass that fails to compile must not take the island with it.
      console.warn('[tidewick] outline pass unavailable, rendering without it', err)
      this.outline = null
    }
  }

  setFraming(framing: 'home' | 'isle'): void {
    this.diorama.setFraming(framing)
  }

  setOutlineEnabled(on: boolean): void {
    this.outlineEnabled = on
  }

  get isOutlineAvailable(): boolean {
    return this.outline !== null
  }

  private get shape(): TerrainShape {
    return {
      bandCount: TERRAIN.terraceBands,
      worldSize: TERRAIN.worldSize,
      peakHeight: TERRAIN.peakHeight,
      smoothing: TERRAIN.terraceSmoothing,
      terraceGrid: TERRAIN.terraceGrid,
    }
  }

  /**
   * Grow the isle for a workspace.
   *
   * Two routes to the same island. With a compute device the worker generates
   * the base field, the GPU erodes it here, and the worker meshes the result;
   * without one the worker does the whole pipeline on the CPU. Both use the
   * identical droplet count and grid, so the terrain is the same either way -
   * what the GPU buys is the headroom to re-erode when a project is added,
   * not a different island.
   */
  /**
   * Carve the isle for a workspace - on the CPU, in the worker, always.
   *
   * There is a GPU erosion path (`erodeGPU`); it is naga-valid, and measured
   * on Intel Iris Xe it beats the CPU by 1.8x at 65k droplets and 4.7x at
   * 130k. It does not carve the isle, for a reason that outranks speed:
   * parallel droplets race on the height field, so two runs from one seed
   * differ - about 5% of terrace cells land in a different band - and "once
   * you begin, this shape is permanent" is a promise the product makes on its
   * first screen. The CPU walk is seeded and deterministic: the same workspace
   * grows the same isle on every machine and every boot. Medium carves 40k
   * droplets in 140-200 ms here, inside the 400 ms budget. The GPU path stays
   * as the benchmark in the README, which is what it is good for.
   *
   * This decision hid behind a bug for a while: a race in the device memo
   * meant the GPU branch never actually ran in development. Fixing the race
   * is what surfaced the question.
   */
  async regenerate(workspaceId: string, droplets = this.budget.droplets): Promise<void> {
    // One worker for the life of the Stage. Terminating and respawning per
    // regeneration threw away a warm JIT every time, which is why the second
    // island took as long as the first; a reply from a superseded request is
    // dropped by sequence number instead.
    const worker = this.worker ?? new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    const seq = ++this.terrainSeq
    const seed = terrainSeed(workspaceId)
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (seq !== this.terrainSeq) return
      if (e.data.type === 'terrain') this.applyTerrain(e.data)
    }
    const req: TerrainRequest = {
      type: 'generate',
      seed,
      erosionGrid: TERRAIN.gridSize,
      droplets,
      shape: this.shape,
    }
    worker.postMessage(req)
  }

  private applyTerrain(data: TerrainResponse): void {
    for (const child of [...this.terrainGroup.children]) {
      this.terrainGroup.remove(child)
      if (child instanceof Mesh) {
        child.geometry.dispose()
        const mat = child.material as { dispose(): void }
        mat.dispose()
      }
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(data.positions, 3))
    geo.setAttribute('normal', new BufferAttribute(data.normals, 3))
    geo.setAttribute('color', new BufferAttribute(data.colors, 3))
    geo.computeBoundingSphere()

    const material = new MeshToonNodeMaterial({
      vertexColors: true,
      gradientMap: makeToonRamp(TERRAIN_RAMP_STOPS),
      side: FrontSide,
    })

    const mesh = new Mesh(geo, material)
    mesh.name = 'terrain'
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.terrainGroup.add(mesh)

    // Hand the shore its land mask. Without this the sea is one flat blue and
    // the island looks like a model sitting on a table.
    this.ocean?.setLandField(data.heightfield, data.heightfieldSize)

    // Retained: the profile answers "where does a plant at this elevation go",
    // but the Keeper needs the raw question "how high is the floor here", and
    // the profile cannot answer that off the radial axis.
    this.terraced = {
      bands: data.bands,
      land: data.land,
      size: data.terraceSize,
      bandCount: data.bandCount,
      cellSize: data.worldSize / data.terraceSize,
      worldSize: data.worldSize,
      peakHeight: data.peakHeight,
    }

    // The radial profile is what lets the shader place a plant at any
    // elevation without searching the heightfield. Rebuilt with the land.
    this.profile = buildRadialProfile(this.terraced)
    this.plants?.setProfile(this.profile)
    this.keeper?.setField(this.terraced)
    this.keeper?.setProfile(this.profile)

    this.ground = createGroundSampler(this.terraced)
    // Grass follows the land: a new island means a new field of blades.
    this.grass?.populate(this.terraced, this.budget.grass, terrainSeed(String(data.bands.length)) ^ data.bandCount)
    if (this.profile) this.footpaths?.rebuild(this.snapshot, this.profile, Date.now())

    this.terrainVertices = data.vertexCount
    this.lastTerrainTimings = data.timings
    this.onTerrainReady?.(data)
  }

  private attachResize(): void {
    const apply = () => {
      const rect = this.container.getBoundingClientRect()
      const w = Math.max(1, Math.floor(rect.width))
      const h = Math.max(1, Math.floor(rect.height))
      this.renderer.setSize(w, h, false)
      this.diorama.setAspect(w / h)
      this.follow?.setAspect(w / h)
    }
    apply()
    this.resizeObserver = new ResizeObserver(apply)
    this.resizeObserver.observe(this.container)
  }

  private renderFrame(dt: number): void {
    if (this.cameraMode === 'keeper' && this.keeper && this.follow) {
      const { state } = this.keeper
      // Real frame time, not the fixed step: the camera is presentation, and
      // pinning it to 60 Hz makes it stutter on a 144 Hz display.
      this.follow.update(state.x, state.y, state.z, this.keeper.sampled, dt)
      this.keeperView?.apply(
        state.x, state.y, state.z, state.yaw,
        this.keeper.pose, this.keeper.isCarrying,
      )
    } else {
      this.diorama.update(dt)
    }

    const camera = this.activeCamera
    if (this.outline && this.outlineEnabled) {
      this.outline.setCamera(camera)
      this.outline.pipeline.render()
    } else {
      this.renderer.render(this.scene, camera)
    }
    // The WebGPU backend records timestamps into a query pool and only
    // resolves them on request; without this the pool fills, warns, and
    // `info.render.timestamp` stays at zero. WebGL2 has no timestamps to
    // resolve and the call is skipped rather than made a no-op.
    if (this.activePath === 'webgpu') void this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER)
  }

  /**
   * Advance every bloom by writing an eased stage value into its instance.
   *
   * Writes straight into the interleaved buffer and marks only those slots
   * dirty, so a bloom costs one float and one small upload per frame - for one
   * plant, for a second and a half.
   */
  private advanceBlooms(): void {
    if (!this.instanceData || !this.plants) return

    const ranges: Array<{ start: number; count: number }> = []
    const still: Bloom[] = []

    for (const bloom of this.blooms) {
      if (bloom.index >= this.snapshot.count) continue
      const elapsed = this.elapsed - bloom.startedAt
      const stage = bloomStage(elapsed)
      // Index 4 of the instance layout is the stage channel.
      this.instanceData[bloom.index * FLOATS_PER_INSTANCE + 4] = stage
      ranges.push({ start: bloom.index, count: 1 })
      if (!bloomFinished(elapsed)) still.push(bloom)
    }

    this.blooms = still
    if (ranges.length > 0) this.plants.markDirty(ranges)
  }

  private get activeCamera(): PerspectiveCamera {
    return this.cameraMode === 'keeper' && this.follow
      ? this.follow.camera
      : this.diorama.camera
  }

  private publishMetrics(t: FrameTiming): void {
    if (!this.onMetrics) return

    this.fpsWindow.push(t.frameMs)
    if (this.fpsWindow.length > 60) this.fpsWindow.shift()
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length

    const info = this.renderer.info
    this.onMetrics({
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: t.frameMs,
      cpuMs: t.cpuMs,
      gpuMs: info.render.timestamp ?? 0,
      drawCalls: info.render.drawCalls,
      triangles: info.render.triangles,
      bufferMemoryMB: (info.memory.attributesSize ?? 0) / (1024 * 1024),
      simSteps: t.steps,
      path: this.activePath,
      adapter: this.capability.adapter,
      tier: this.tier,
      terrainVertices: this.terrainVertices,
      terrain: this.lastTerrainTimings,
      plants: this.snapshot.count,
      agents: this.birds?.count ?? 0,
      grassBlades: this.grass?.count ?? 0,
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
      renderScale: this.renderScale,
      deriveMs: this.lastDeriveMs,
      uploadBytes: this.lastDiff.bytes,
      uploadInstances: this.lastDiff.changed,
    })
  }

  /**
   * Time N frames back to back, outside requestAnimationFrame.
   *
   * rAF is throttled or suspended entirely in a backgrounded or non-compositing
   * tab, which makes the HUD's frame-time figure meaningless in exactly the
   * environments most convenient for automated checking. This drives the render
   * path directly and awaits the GPU queue, so the number is the real cost of a
   * frame rather than the cost of waiting for a vsync that never arrives.
   */
  /**
   * Measure real frames.
   *
   * The first version timed `renderAsync` calls in a loop and reported 0.07 ms
   * a frame for a 98k-triangle scene with shadows and a post pass - because
   * `renderAsync` resolves when the *commands are submitted*, not when the GPU
   * has drawn them, and nothing forced completion. It was measuring the CPU's
   * enthusiasm. This version watches the live loop instead: it records the
   * wall-clock interval between presented frames, and the CPU time inside our
   * own update and render, for `count` frames. Those are the two numbers the
   * budget in Section 15 is actually written in.
   *
   * GPU time is reported only when the backend produces timestamps. On WebGL2
   * here it does not, and a zero would be a lie, so it comes back as null.
   */
  benchmarkFrames(count = 120): Promise<FrameBenchmark> {
    return new Promise((resolve) => {
      const frames: number[] = []
      const cpu: number[] = []
      let skipped = 0
      const listener = (t: FrameTiming) => {
        // Discard the first few: shader compilation and pipeline warm-up land
        // there, and a clamped catch-up frame is not a real frame.
        if (skipped < 10) { skipped++; return }
        if (t.frameMs >= MAX_FRAME_MS) return
        frames.push(t.frameMs)
        cpu.push(t.cpuMs)
        if (frames.length < count) return

        this.timingListeners.delete(listener)
        frames.sort((a, b) => a - b)
        cpu.sort((a, b) => a - b)
        const at = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]
        const gpu = this.renderer.info.render.timestamp
        resolve({
          frames: frames.length,
          medianFrameMs: at(frames, 0.5),
          p95FrameMs: at(frames, 0.95),
          medianCpuMs: at(cpu, 0.5),
          p95CpuMs: at(cpu, 0.95),
          gpuMs: gpu && gpu > 0 ? gpu : null,
          drawCalls: this.renderer.info.render.drawCalls,
          triangles: this.renderer.info.render.triangles,
          width: this.renderer.domElement.width,
          height: this.renderer.domElement.height,
          path: this.activePath,
          tier: this.tier,
        })
      }
      this.timingListeners.add(listener)
    })
  }

  /**
   * Internal resolution, as a fraction of the display's.
   *
   * Every fill-bound pass - sea, sky, grass fragments, the ink, the bloom
   * chain - scales with it, which makes it the one knob that can rescue a
   * 60 fps budget on an integrated GPU once a tier's counts already sit at the
   * brief's minimums. It is a device setting, never a tier: the same isle on
   * the same tier looks identical everywhere except in how many pixels it was
   * drawn with, and the HUD shows that size so 75% is never mistaken for 1080p.
   */
  setRenderScale(scale: number): void {
    if (this.scaleLocked) return
    this.renderScale = clampScale(scale)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.renderScale)
    const rect = this.container.getBoundingClientRect()
    this.renderer.setSize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)), false)
  }

  /**
   * The measurement that does not need a visible window.
   *
   * `benchmarkFrames` waits for presented frames, and a hidden pane presents
   * none. This drives the render synchronously `count` times and, on the
   * WebGL2 backend, waits for the GPU with `gl.finish()` after each one. The
   * time per iteration is CPU submit plus GPU work *serialised* - a cost a
   * pipelined display never pays in full - so it is an upper bound on the
   * frame, and is reported as one. The presented-frame figure stays with
   * `benchmarkFrames`. Without a WebGL context the finish half is null rather
   * than a number that means something else.
   *
   * Two things this has to do that a naive loop does not, both found by
   * running it in a hidden pane and getting 0.2 ms frames:
   *
   * 1. Advance the renderer's node frame by hand. The renderer owns a
   *    requestAnimationFrame loop that ticks `nodeFrame` once per displayed
   *    frame, and every post-processing pass renders its scene once per node
   *    frame. With no display there is no tick, so 125 calls to render drew
   *    the scene once and the composite quad 125 times - and the first
   *    version of this reported the quad. `nodeFrame.update()` is what the
   *    animation loop would have called.
   * 2. Wait with `finish()`, and only `finish()`. A fence would be the more
   *    precise wait, but a browser updates a sync object's status from its
   *    event loop, so polling `clientWaitSync` from a synchronous loop never
   *    sees it signal - in a hidden document that is an infinite loop, and
   *    was. `finish()` is the strongest synchronisation WebGL offers without
   *    yielding, and a serialised time equal to the submit time means the GPU
   *    kept pace with submission, which is the claim being tested.
   */
  benchmarkSubmit(count = 120): SubmitBenchmark {
    const renderer = this.renderer as unknown as {
      backend?: { gl?: WebGL2RenderingContext }
      _nodes?: { nodeFrame?: { update(): void } }
    }
    const gl = renderer.backend?.gl ?? null
    const nodeFrame = renderer._nodes?.nodeFrame ?? null
    const submit: number[] = []
    const serialised: number[] = []
    const WARMUP = 5
    for (let i = 0; i < count + WARMUP; i++) {
      nodeFrame?.update()
      // Draw and triangle counts accumulate across synchronous renders (the
      // animation loop is what normally resets them), so clear before the
      // last frame and report that one frame's numbers.
      if (i === count + WARMUP - 1) this.renderer.info.reset()
      const t0 = performance.now()
      this.renderFrame(1 / 60)
      const t1 = performance.now()
      if (gl) gl.finish()
      const t2 = performance.now()
      if (i < WARMUP) continue
      submit.push(t1 - t0)
      if (gl) serialised.push(t2 - t0)
    }
    submit.sort((a, b) => a - b)
    serialised.sort((a, b) => a - b)
    const at = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]
    return {
      frames: submit.length,
      medianSubmitMs: at(submit, 0.5),
      p95SubmitMs: at(submit, 0.95),
      medianSerialisedMs: gl ? at(serialised, 0.5) : null,
      p95SerialisedMs: gl ? at(serialised, 0.95) : null,
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
      path: this.activePath,
      tier: this.tier,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loop.stop()
    this.stopMotionWatch?.()
    this.worker?.terminate()
    this.resizeObserver?.disconnect()
    this.diorama.dispose()
    this.follow?.dispose()
    this.keeperInput?.dispose()
    this.keeperView?.dispose()
    this.outline?.dispose()
    this.sky?.dispose()
    this.ocean?.dispose()
    this.plants?.dispose()
    this.footpaths?.dispose()
    this.grass?.dispose()
    this.birds?.dispose()
    this.deriveWorker?.terminate()
    this.renderer.dispose()
    this.canvas.remove()
  }
}
