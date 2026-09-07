import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { detectCapability, type Capability } from '@/render/capability'
import { Stage, type StageMetrics } from '@/render/stage'
import { PerfHUD } from '@/hud/PerfHUD'
import { Home } from '@/home/Home'
import { useWorkspaceStore, newWorkspaceId } from '@/state/store'
import { createWorkspace } from '@/state/types'
import { loadMostRecent, flushWorkspace } from '@/state/persistence'
import { daylightAt, toHex, type DaylightState } from '@/core/daylight'
import { Workspace } from '@/workspace/Workspace'
import { blendSeasons } from '@/render/palette'
import { tendCommand, rescheduleCommand } from '@/keeper/commands'
import type { CameraMode } from '@/render/stage'
import { KeeperHUD } from '@/keeper/KeeperHUD'
import { useFocusSession } from '@/loop/useFocusSession'
import { FocusTimer } from '@/loop/FocusTimer'
import { HarvestCard } from '@/loop/HarvestCard'
import { seasonProgress, seasonBlend, summariseSeason } from '@/loop/seasons'
import { harvestFor, LightLantern } from '@/loop/loopCommands'
import { CommandPalette, type PaletteAction, type PaletteTarget } from '@/workspace/CommandPalette'
import { SettingsPanel } from '@/workspace/SettingsPanel'
import { loadSettings, saveSettings, type DeviceSettings } from '@/core/settings'
import { nextQualityStep, applyBenchmarkOutcome, type QualityStep } from '@/core/autoQuality'
import { devOverrides } from '@/core/config'
import { applyPack, type Pack } from '@/packs/placementPrep'
import { exportWorkspace, importWorkspace, pageToMarkdown, downloadText, exportFilename } from '@/state/transfer'
import { createAmbience, type Ambience } from '@/sound/ambience'
import { countLanterns } from '@/island/derive'
import { CreatePage } from '@/state/blockCommands'
import { CreateDatabase, AddProperty, AddView } from '@/state/databaseCommands'

/**
 * Application shell.
 *
 * The island is created once and kept alive for the whole session - the home
 * page renders *over* it rather than instead of it, so entering the isle is a
 * scrim fading out rather than a scene loading. Section 11 asks for a
 * continuous camera move between the two halves and never a hard cut; this is
 * the same principle applied one level up.
 */
export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<Stage | null>(null)

  const workspace = useWorkspaceStore((s) => s.workspace)
  const hydrate = useWorkspaceStore((s) => s.hydrate)
  const dispatchCommand = useWorkspaceStore((s) => s.dispatch)

  const [capability, setCapability] = useState<Capability | null>(null)
  const [metrics, setMetrics] = useState<StageMetrics | null>(null)
  const [daylight, setDaylight] = useState<DaylightState | null>(() => daylightAt())
  // Device settings: tier, sound, clouds, HUD. Outside the workspace on
  // purpose - they describe this machine, not the isle (see core/settings.ts).
  const [settings, setSettings] = useState<DeviceSettings>(() => loadSettings())
  const [hudVisible, setHudVisible] = useState(() => loadSettings().hud)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [requestedTarget, setRequestedTarget] = useState<{ kind: 'page' | 'database'; id: string; nonce: number } | null>(null)
  const [currentPageId, setCurrentPageId] = useState<string | null>(null)
  const ambienceRef = useRef<Ambience | null>(null)
  const [outlineEnabled, setOutlineEnabled] = useState(true)
  const [outlineAvailable, setOutlineAvailable] = useState(false)
  const [islandReady, setIslandReady] = useState(false)
  // Three views over one live scene. Section 11 asks for Tab to toggle
  // workspace and isle; home is the third, and every transition is a scrim
  // fade over the same renderer rather than a mount.
  const [view, setView] = useState<'home' | 'isle' | 'workspace'>('home')
  const [booting, setBooting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [storageWarning, setStorageWarning] = useState(false)
  const [openedFromIsle, setOpenedFromIsle] = useState<string | null>(null)
  // The Keeper. `walking` is the camera mode; the prompt is whatever is in
  // reach, mirrored out of the render loop so React can draw it.
  const [walking, setWalking] = useState(false)
  const [keeperPrompt, setKeeperPrompt] = useState('')
  const [harvestDismissed, setHarvestDismissed] = useState(false)

  // The focus session. Golden hour is pushed to the island from here, so the
  // light on the isle is a direct function of measured attention.
  const focus = useFocusSession()

  // --- restore the last workspace, or found a new one -----------------------
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await loadMostRecent()
      if (cancelled) return

      if (result.status === 'ok') {
        hydrate(result.state)
      } else if (result.status === 'empty') {
        // Genuinely nothing saved: found a workspace and commit it, so a
        // reload mid-founding does not reroll the island.
        hydrate(useWorkspaceStore.getState().workspace, true)
      } else {
        // The read failed. Carry on in memory but write nothing - saving now
        // would create a second workspace that shadows the real one forever.
        setStorageWarning(true)
      }
      setRestored(true)
    })()
    return () => { cancelled = true }
  }, [hydrate])

  // Persist anything still in the debounce window before the tab goes away.
  useEffect(() => {
    const flush = () => { void flushWorkspace() }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      void flushWorkspace()
    }
  }, [])

  // --- boot the renderer ----------------------------------------------------
  useEffect(() => {
    if (!restored) return
    let cancelled = false
    let stage: Stage | null = null

    void (async () => {
      try {
        const detected = await detectCapability()
        if (cancelled) return
        // A saved tier override wins over detection. Applied here, before the
        // Stage exists, because the tier decides buffer sizes at construction.
        const saved = loadSettings()
        const override = saved.tier ?? saved.autoTier
        const cap = override ? { ...detected, suggestedTier: override } : detected
        setCapability(cap)

        if (cap.path === 'none') {
          setError(cap.reason)
          setBooting(false)
          return
        }

        const container = containerRef.current
        if (!container) return

        stage = await Stage.create(container, cap, { renderScale: loadSettings().renderScale })
        if (cancelled) {
          stage.dispose()
          return
        }
        stageRef.current = stage
        setOutlineAvailable(stage.isOutlineAvailable)
        setBooting(false)
        // Cold start, measured rather than estimated: the shell is interactive
        // here. The isle itself arrives a moment later and marks tidewick:island.
        performance.mark('tidewick:interactive')

        if (import.meta.env.DEV) {
          void import('./dev/benchmark').then((m) => stage && m.registerStage(stage))
        }

        // Throttle HUD state to ~10 Hz. Re-rendering React at display refresh
        // to show a frame-time number is a funny way to become the bottleneck
        // you are trying to measure.
        let lastPublish = 0
        stage.onMetrics = (m) => {
          const now = performance.now()
          if (now - lastPublish < 100) return
          lastPublish = now
          setMetrics(m)
          setDaylight(stage?.daylightState ?? null)
        }

        // The island as an input surface. Both of these build the *same*
        // commands the DOM interface builds - Section 2's requirement - which
        // is why undo and persistence behave identically from either half.
        const keeper = stage.keeperSystem
        const store = useWorkspaceStore.getState()
        keeper.titleFor = (pageId) =>
          useWorkspaceStore.getState().workspace.pages[pageId]?.title ?? ''
        keeper.onTend = (pageId) => {
          const command = tendCommand(useWorkspaceStore.getState().workspace, pageId)
          if (!command) return
          store.dispatch(command)
          // The bloom, dispatched alongside the completion rather than instead
          // of it: with an empty reserve the task still completes.
          store.dispatch(new LightLantern())
        }
        keeper.onReschedule = (pageId, due) => {
          const command = rescheduleCommand(useWorkspaceStore.getState().workspace, pageId, due)
          if (command) store.dispatch(command)
        }
        keeper.onPromptChange = (prompt) => setKeeperPrompt(prompt)
        stage.onCameraMode = (mode: CameraMode) => setWalking(mode === 'keeper')

        stage.onTerrainReady = () => {
          if (performance.getEntriesByName('tidewick:island').length === 0) performance.mark('tidewick:island')
          setIslandReady(true)
          // Terrain settled, so the profile exists: grow the plants on it.
          stage?.updateWorld(useWorkspaceStore.getState().workspace)
        }
        await stage.regenerate(useWorkspaceStore.getState().workspace.meta.id)
      } catch (err) {
        if (cancelled) return
        console.error('[tidewick] boot failed', err)
        setError(err instanceof Error ? err.message : String(err))
        setBooting(false)
      }
    })()

    return () => {
      cancelled = true
      stage?.dispose()
      stageRef.current = null
    }
  }, [restored])

  // --- regrow when the workspace id changes (founding a different isle) -----
  const lastSeededId = useRef<string | null>(null)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const id = workspace.meta.id
    if (lastSeededId.current === id) return
    lastSeededId.current = id
    setIslandReady(false)
    void stage.regenerate(id)
  }, [workspace.meta.id, booting])

  /**
   * The island follows the workspace.
   *
   * One subscription, no sync code. Section 2 is satisfied structurally here:
   * there is no branch that decides *what* changed, because derive() takes the
   * whole state and the bridge works out the difference. Adding a feature to
   * the workspace cannot forget to update the isle.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    stage.updateWorld(workspace)
  }, [workspace, booting])

  useEffect(() => {
    stageRef.current?.setGoldenHour(focus.golden)
  }, [focus.golden, booting])

  // Settings are remembered as they change, and pushed where they apply.
  useEffect(() => {
    saveSettings(settings)
    stageRef.current?.setCloudCover(settings.clouds)
    stageRef.current?.setRenderScale(settings.renderScale)
  }, [settings, booting])

  /**
   * First-run quality benchmark - Section 15's "auto-detect a quality tier
   * with a short benchmark". Once the isle is up, measure presented frames and
   * let `nextQualityStep` lower the render scale until the frame fits; if the
   * smallest scale still misses, the tier below is recorded for the next
   * start. Skipped when a tier was chosen by hand, when the tab is hidden (a
   * hidden document presents no frames to measure) and under development
   * overrides, and never run twice in a session.
   */
  const benchmarkState = useRef<'idle' | 'running' | 'done'>('idle')
  useEffect(() => {
    if (booting || !islandReady || benchmarkState.current !== 'idle') return
    if (settings.tier !== null || settings.benchmarked) return
    if (Object.keys(devOverrides()).length > 0 || document.hidden) return
    const stage = stageRef.current
    if (!stage) return
    benchmarkState.current = 'running'
    let cancelled = false
    void (async () => {
      // Let shader compilation and the first uploads settle first.
      await new Promise((r) => setTimeout(r, 2500))
      if (cancelled) return
      let scale = settings.renderScale
      let outcome: QualityStep | null = null
      for (let i = 0; i < 4 && !cancelled; i++) {
        const result = await Promise.race([
          stage.benchmarkFrames(90),
          new Promise<null>((r) => setTimeout(() => r(null), 8000)),
        ])
        if (!result) { benchmarkState.current = 'idle'; return } // no frames presented: try next start
        outcome = nextQualityStep(result.medianFrameMs, stage.qualityTier, scale)
        if (outcome.renderScale !== scale) {
          scale = outcome.renderScale
          stage.setRenderScale(scale)
        }
        if (outcome.done) break
      }
      if (cancelled || !outcome) return
      benchmarkState.current = 'done'
      const final = outcome
      // One miss is a strike, two are a demotion: see applyBenchmarkOutcome.
      setSettings((s) => applyBenchmarkOutcome(s, final, stage.qualityTier))
    })()
    return () => {
      cancelled = true
      // StrictMode's synthetic unmount: give the slot back so the re-run runs.
      if (benchmarkState.current === 'running') benchmarkState.current = 'idle'
    }
  }, [booting, islandReady, settings.tier, settings.benchmarked, settings.renderScale])

  /**
   * Sound follows the setting. The AudioContext is not created until the
   * person turns sound on - browsers block autoplay, and a context made at boot
   * spends its life suspended and logging warnings.
   */
  useEffect(() => {
    if (settings.sound) {
      ambienceRef.current ??= createAmbience()
      void ambienceRef.current.start()
      ambienceRef.current.setVolume(settings.volume)
    } else {
      ambienceRef.current?.stop()
    }
  }, [settings.sound, settings.volume])

  useEffect(() => () => { ambienceRef.current?.dispose() }, [])

  // One soft bell when a lantern lights, from either half of the product:
  // derived from the count, so the isle and the table ring the same bell.
  const lanternCount = useMemo(() => countLanterns(workspace), [workspace])
  const previousLanterns = useRef(lanternCount)
  useEffect(() => {
    if (lanternCount > previousLanterns.current) ambienceRef.current?.chime()
    previousLanterns.current = lanternCount
  }, [lanternCount])

  // Ctrl+K / Cmd+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The Keeper wears what was chosen at founding. Section 4: "user-named and
  // dressed" - the colours were saved for three phases before anyone wore them.
  useEffect(() => {
    stageRef.current?.setKeeperColours(workspace.meta.keeper.colours)
  }, [workspace.meta.keeper.colours, booting])

  /**
   * The island wears the season the workspace is in.
   *
   * Including the cross-fade, which begins before the season actually turns -
   * so by the time the Harvest Festival arrives the land already looks like
   * the season it is becoming.
   */
  const blend = useMemo(
    () => seasonBlend(seasonProgress(workspace, Date.now())),
    [workspace.meta.seasonIndex, workspace.meta.seasonStartedAt],
  )

  useEffect(() => {
    stageRef.current?.setSeason(blend.from, blend.t)
  }, [blend, booting, islandReady])

  /**
   * Is the Harvest Festival waiting?
   *
   * Computed rather than scheduled. A local-first app may not be running when
   * a season technically ends, so there is no timer to miss - the festival is
   * simply true the next time you look, which is also why it survives being
   * closed for a fortnight.
   */
  const harvest = useMemo(() => {
    if (booting || !workspace.meta.onboarded) return null
    const progress = seasonProgress(workspace, Date.now())
    if (!progress.harvestReady) return null
    return summariseSeason(workspace, Date.now())
  }, [workspace, booting])

  const handleHarvest = useCallback(() => {
    dispatchCommand(harvestFor(useWorkspaceStore.getState().workspace, Date.now()))
    setHarvestDismissed(false)
  }, [])

  /** Clicking a plant opens its page - the world is an input surface. */
  const handleIslandClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    if (!stage || view !== 'isle') return
    const pageId = stage.pick(e.clientX, e.clientY)
    if (!pageId) return
    setOpenedFromIsle(pageId)
    setView('workspace')
  }, [view])

  // Entering and leaving is a camera move, never a cut.
  useEffect(() => {
    stageRef.current?.setFraming(view === 'isle' ? 'isle' : 'home')
  }, [view, booting])

  /**
   * The Keeper only walks on the isle.
   *
   * Leaving the isle hands the camera back to the diorama and silences the
   * Keeper's keys - otherwise typing a page title in the workspace would send
   * them sprinting, since both halves share one window.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (view !== 'isle') {
      stage.setCameraMode('diorama')
      stage.setInputSuspended(true)
      setKeeperPrompt('')
      return
    }
    stage.setInputSuspended(false)
  }, [view, booting])

  const handleToggleWalking = useCallback(() => {
    const stage = stageRef.current
    if (!stage || view !== 'isle') return
    stage.setCameraMode(stage.mode === 'keeper' ? 'diorama' : 'keeper')
  }, [view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault()
        setHudVisible((v) => !v)
        return
      }
      if (e.key === 'Escape') {
        if (paletteOpen || settingsOpen) return // the sheet handles its own Escape
        if (view !== 'home') setView('home')
        return
      }
      // Tab toggles the two halves - but only when the caret is not in a text
      // field, or it would steal Tab from the editor's indent.
      if (e.key === 'Tab' && !e.shiftKey && view !== 'home') {
        const active = document.activeElement as HTMLElement | null
        const editing = active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA'
        if (editing) return
        e.preventDefault()
        setView((v) => (v === 'isle' ? 'workspace' : 'isle'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, paletteOpen, settingsOpen])

  /**
   * Silence the Keeper while the caret is in text.
   *
   * The editor is a contenteditable living in the same window as the isle, so
   * without this, typing "was" walks the Keeper off a cliff behind you.
   */
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      const node = el as HTMLElement | null
      return Boolean(node?.isContentEditable) || node?.tagName === 'INPUT' || node?.tagName === 'TEXTAREA'
    }
    const onFocus = (e: FocusEvent) => stageRef.current?.setInputSuspended(isEditable(e.target))
    const onBlur = () => stageRef.current?.setInputSuspended(false)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', onBlur)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onBlur)
    }
  }, [])

  const handleToggleOutline = useCallback((next: boolean) => {
    setOutlineEnabled(next)
    stageRef.current?.setOutlineEnabled(next)
  }, [])

  /**
   * Found a different isle.
   *
   * Rolls a brand-new workspace id, which is what the terrain seed hashes -
   * so this genuinely regrows the land rather than reskinning it. Only
   * reachable before onboarding completes; after that the shape is permanent,
   * which is the point.
   */
  // One accent for both halves, so the DOM and the island agree about the hour.
  const accent = useMemo(() => {
    // The blended palette, not the raw season: the DOM half and the island
    // half must agree during the cross-fade as well as outside it.
    const season = blendSeasons(blend.from, blend.to, blend.t)
    if (!daylight) return season.accent
    return blendHex(season.accent, toHex(daylight.skyHorizon), 0.28)
  }, [blend, daylight])

  const openTarget = useCallback((target: PaletteTarget) => {
    if (target.kind === 'action') return
    setRequestedTarget({ kind: target.kind, id: target.id, nonce: Date.now() })
    setView('workspace')
  }, [])

  const handleApplyPack = useCallback((pack: Pack) => {
    const applied = applyPack(pack, dispatchCommand)
    const first = applied.pageIds[0] ?? null
    if (first) setRequestedTarget({ kind: 'page', id: first, nonce: Date.now() })
    else if (applied.databaseIds[0]) setRequestedTarget({ kind: 'database', id: applied.databaseIds[0], nonce: Date.now() })
    setView('workspace')
  }, [dispatchCommand])

  const handleExportJson = useCallback(() => {
    const state = useWorkspaceStore.getState().workspace
    downloadText(exportFilename(state.meta.isleName, 'json'), exportWorkspace(state))
  }, [])

  const handleExportMarkdown = useCallback(() => {
    const state = useWorkspaceStore.getState().workspace
    if (!currentPageId) return
    const title = state.pages[currentPageId]?.title || 'page'
    downloadText(exportFilename(title, 'md'), pageToMarkdown(state, currentPageId), 'text/markdown')
  }, [currentPageId])

  const handleImport = useCallback((text: string) => {
    const result = importWorkspace(text)
    // Persisted immediately: an import that only lived in memory would vanish
    // on the next reload and look like it never worked.
    if (result.ok) hydrate(result.workspace, true)
    return result
  }, [hydrate])

  /** Everything the palette can do that is not "open a thing". */
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const newPage = () => {
      const create = new CreatePage(null)
      dispatchCommand(create)
      setRequestedTarget({ kind: 'page', id: create.pageId, nonce: Date.now() })
      setView('workspace')
    }
    const newDatabase = () => {
      const create = new CreateDatabase('Untitled database')
      dispatchCommand(create)
      dispatchCommand(new AddProperty(create.databaseId, 'status', 'Status'))
      dispatchCommand(new AddProperty(create.databaseId, 'date', 'Due'))
      dispatchCommand(new AddView(create.databaseId, 'Board', 'board'))
      setRequestedTarget({ kind: 'database', id: create.databaseId, nonce: Date.now() })
      setView('workspace')
    }
    return [
      { id: 'new-page', label: 'New page', hint: 'Create', keywords: ['create', 'blank', 'note'], run: newPage },
      { id: 'new-database', label: 'New database', hint: 'Create - a Status, a Due date and a Board', keywords: ['create', 'table', 'project', 'region'], run: newDatabase },
      { id: 'isle', label: 'Enter the isle', hint: 'View', keywords: ['island', 'walk', '3d'], run: () => setView('isle') },
      { id: 'workspace', label: 'Open the workspace', hint: 'View', keywords: ['pages', 'editor', 'notes'], run: () => setView('workspace') },
      { id: 'home', label: 'Go home', hint: 'View', keywords: ['start', 'overview'], run: () => setView('home') },
      { id: 'walk', label: 'Walk the isle as the Keeper', hint: 'View - V', keywords: ['keeper', 'character', 'third person'], run: () => { setView('isle'); stageRef.current?.setCameraMode('keeper') } },
      focus.running
        ? { id: 'focus-end', label: 'Finish the focus session', hint: 'Focus', keywords: ['stop', 'timer', 'pomodoro'], run: focus.end }
        : { id: 'focus-begin', label: 'Begin a focus session', hint: 'Focus - 25 min', keywords: ['start', 'timer', 'pomodoro', 'sunlight'], run: focus.begin },
      { id: 'settings', label: 'Settings', hint: 'Quality, sound, weather', keywords: ['preferences', 'options', 'tier', 'sound', 'clouds'], run: () => setSettingsOpen(true) },
      { id: 'templates', label: 'Add a template', hint: 'Placement prep, weekly review, reading list', keywords: ['pack', 'starter', 'placement'], run: () => setSettingsOpen(true) },
      { id: 'export', label: 'Export everything', hint: 'JSON, to a file', keywords: ['backup', 'save', 'download'], run: handleExportJson },
      { id: 'hud', label: hudVisible ? 'Hide the performance overlay' : 'Show the performance overlay', hint: 'F3', keywords: ['fps', 'stats', 'debug'], run: () => setHudVisible((v) => !v) },
      { id: 'undo', label: 'Undo', hint: 'Ctrl+Z', keywords: ['back'], run: () => useWorkspaceStore.getState().undo() },
      { id: 'redo', label: 'Redo', hint: 'Ctrl+Shift+Z', keywords: ['forward'], run: () => useWorkspaceStore.getState().redo() },
    ]
  }, [dispatchCommand, focus.running, focus.begin, focus.end, hudVisible, handleExportJson])

  const handleReshape = useCallback(() => {
    const fresh = createWorkspace(newWorkspaceId())
    fresh.meta.isleName = useWorkspaceStore.getState().workspace.meta.isleName
    hydrate(fresh)
  }, [hydrate])

  return (
    <main className="app">
      <div className="stage" ref={containerRef} onClick={handleIslandClick} />

      {booting && !error && (
        <div className="curtain" role="status">
          <p className="curtain__line">Finding the sea floor…</p>
          {capability && <p className="curtain__sub">{capability.reason}</p>}
        </div>
      )}

      {error && (
        <div className="curtain curtain--error" role="alert">
          <p className="curtain__line">The isle could not be drawn.</p>
          <p className="curtain__sub">{error}</p>
          <p className="curtain__sub">
            This is survivable by design: the workspace half of Tidewick never requires the island.
          </p>
        </div>
      )}

      {!booting && !error && view === 'home' && (
        <Home
          workspace={workspace}
          daylight={daylight}
          islandReady={islandReady}
          onEnter={() => setView('isle')}
          onOpenWorkspace={() => setView('workspace')}
          onReshape={handleReshape}
        />
      )}

      {view === 'isle' && (
        <>
          <div className="isle-bar">
            <button type="button" className="back-home" onClick={() => setView('home')}>
              &larr; Home
            </button>
            <button type="button" className="back-home" onClick={() => setView('workspace')}>
              Workspace <kbd>Tab</kbd>
            </button>
            <button type="button" className="back-home" onClick={() => setPaletteOpen(true)}>
              Search <kbd>Ctrl K</kbd>
            </button>
            <button type="button" className="back-home" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
          <KeeperHUD
            walking={walking}
            prompt={keeperPrompt}
            onToggleWalking={handleToggleWalking}
          />
        </>
      )}

      {/*
        The timer lives on the isle and in the workspace both: focus is the
        thing the two halves share, and hiding it behind a view switch would
        make starting a session a chore.
      */}
      {!booting && !error && view !== 'home' && (
        <div className={`focus-dock${view === 'workspace' ? ' focus-dock--workspace' : ''}`}>
          <FocusTimer
            session={focus.session}
            running={focus.running}
            sunlight={workspace.meta.sunlight}
            onBegin={focus.begin}
            onHold={focus.hold}
            onEnd={focus.end}
          />
        </div>
      )}

      {harvest && !harvestDismissed && view !== 'home' && (
        <HarvestCard
          summary={harvest}
          seasonIndex={workspace.meta.seasonIndex}
          isleName={workspace.meta.isleName}
          onKeep={handleHarvest}
          onLater={() => setHarvestDismissed(true)}
        />
      )}

      {view === 'workspace' && (
        <Workspace
          accent={accent}
          initialPageId={openedFromIsle}
          requestedTarget={requestedTarget}
          onCurrentPage={setCurrentPageId}
          onSearch={() => setPaletteOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onLeave={() => setView('home')}
          onToIsle={() => setView('isle')}
        />
      )}

      <CommandPalette
        workspace={workspace}
        actions={paletteActions}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={openTarget}
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        detectedTier={capability?.suggestedTier ?? 'medium'}
        activeTier={stageRef.current?.qualityTier ?? capability?.suggestedTier ?? 'medium'}
        isleName={workspace.meta.isleName}
        hasPage={view === 'workspace' && currentPageId !== null}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
        onApplyPack={handleApplyPack}
        onExportJson={handleExportJson}
        onExportMarkdown={handleExportMarkdown}
        onImport={handleImport}
      />

      {storageWarning && (
        <p className="storage-warning" role="status">
          Could not read local storage. Nothing will be saved this session, and your
          existing isle is untouched.
        </p>
      )}

      <PerfHUD
        metrics={metrics}
        visible={hudVisible}
        outlineEnabled={outlineEnabled}
        outlineAvailable={outlineAvailable}
        onToggleOutline={handleToggleOutline}
      />
    </main>
  )
}

/** Blend two #rrggbb strings. Shared with the home page's accent logic. */
function blendHex(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const pa = parse(a)
  const pb = parse(b)
  const to = (x: number) => Math.round(x).toString(16).padStart(2, '0')
  return `#${to(pa[0] + (pb[0] - pa[0]) * t)}${to(pa[1] + (pb[1] - pa[1]) * t)}${to(pa[2] + (pb[2] - pa[2]) * t)}`
}
