# Tidewick — build plan

A local-first, offline, cross-platform workspace that is also a walkable toon island.
Derived from `LANTERN_ISLE_BUILD_PROMPT.md`; this file is the working plan and the
record of decisions taken.

---

## Decisions taken (Section 19 of the brief)

| Decision | Choice | Reasoning |
|---|---|---|
| **Name** | **Tidewick** | Tide = the elevation/waterline mechanic, wick = the lanterns. Both core mechanics in one word, and it has no meaningful namespace collisions. |
| **Season length** | 14 days | Default. Revisit after Phase 7 when the Harvest Festival is actually playable. |
| **Elevation horizon** | 90 days | Default. Single constant in `src/core/config.ts`; the brief is right that it sets the emotional temperature, so it stays a one-line edit. |
| **Editor core** | Deferred to Phase 2 | Leaning TipTap. A custom block model is 3–4 weeks and the distinctive engineering in this project is the derivation, the formula engine and the compute shaders — not re-solving contenteditable. |
| **Sound** | In scope, Phase 8 | Cheap for the warmth it buys. |
| **Terrain art direction** | **Erode, then terrace** | See below. |
| **Scope** | Full product, all 8 phases | User's call, taken with the schedule risk understood. |

### Terrain art direction — erode, then terrace

The brief specifies hydraulic erosion; the reference art is chunky flat-shaded
low-poly with hard cliff faces. Those look like different products. They are not:
run the droplet erosion on the continuous field first, so water carves real
drainage, **then** quantise height into discrete bands. Cliff walls end up
following the eroded valley network — which is exactly the stepped-plateau
silhouette in the reference, and is something neither step produces alone.

This also resolved a design hole in the brief. Section 3 makes a project *a
region*; Section 4 puts a task at *the elevation matching its due date, within
its project's region footprint*. Both cannot hold for a compact region — a
coastal meadow has nowhere to put work due in 89 days. Terraced plateaus at
discrete heights give every region a full set of elevations to place into.

---

## Phase status

| Phase | State |
|---|---|
| **1 — Foundation, terrain, toon renderer** | Substantially complete; see gaps below |
| **Home page** *(added on request)* | Done — live island, real time of day, founding flow |
| **2 — Data layer and block editor** | Done, bar drag-to-reorder and paste |
| **3 — Databases and views** | Done, bar the Timeline (which is Phase 5) |
| **4 — Derivation and the living island** | Done |
| **5 — Timeline, relations, formulas, ocean** | Done; FFT ocean written but unexecuted |
| **6 — The Keeper** | Done |
| **7 — The gentle loop** | Done |
| 8 — Compute showpieces, polish, ship | **Done on this machine** (2026-09-07); what needs other hardware is listed in the section |

### Phase 1 — done

- Vite + React 19 + TypeScript (strict) scaffold.
- `WebGPURenderer` with runtime capability detection and automatic WebGL2 fallback.
- Fixed-timestep simulation loop (60 Hz) with interpolated rendering, decoupled
  from display refresh.
- Performance HUD on `F3`: frame graph, CPU/GPU split, draw calls, triangles,
  GPU buffer memory, active render path, adapter string, sim tick rate, and the
  full terrain-generation timing breakdown.
- Deterministic heightfield from a stable workspace hash (FNV-1a → mulberry32 →
  seeded Perlin).
- Droplet hydraulic erosion, **two implementations**: CPU reference (also the
  WebGL2 fallback) and WGSL compute on a standalone `GPUDevice`.
- Terracing, flat-shaded single-mesh island, cel-banded toon material,
  screen-space depth-and-normal outline pass.
- Orbiting diorama camera, keyboard-navigable, `prefers-reduced-motion` honoured.
- 29 unit tests; WGSL validated offline with `naga`.

### Home page and world clock — done

Not in the original brief's phase list; requested directly, and it pulled the
Phase 2 foundation forward with it.

- **Daylight system** (`src/core/daylight.ts`). Keyframed around the clock,
  cyclically interpolated so midnight has no seam, driving sky gradient, sun
  colour and angle, bounce light and sea brightness. Pure, three.js-free and
  unit-tested; the DOM half draws its accent from the same source so the two
  halves cannot disagree about what colour the evening is.
- **Sky dome** (`src/render/sky.ts`) as a TSL node material with a vertical
  gradient and forward scatter around the sun. Advancing time is four uniform
  writes, not a rebuilt vertex-colour attribute.
- **Shore-aware sea** (`src/render/ocean.ts`). The worker's post-erosion field
  is blurred into a land mask; the shader reads shallowness from it and derives
  a foam band at the waterline. Phase 5's FFT ocean needs this same field for
  its shore blend, so it is not throwaway.
- **Home page** (`src/home/`). The live island *is* the background — entering
  the isle is a camera move and a scrim fade, never a scene load. Founding flow
  (name the isle, name and dress the Keeper) plus a returning view with a
  time-aware greeting, live clock, season, days tended, lanterns and focus.
- **State foundation** (`src/state/`). Zustand + Immer store with **no setters**:
  the only way in is `dispatch(command)`. Bounded undo/redo stack. Immer patches
  collected on every mutation, ready for Phase 4's dirty set. Dexie persistence,
  write-behind and debounced at 400 ms.

Two findings worth keeping:

1. **An overhead sun is the worst possible light for terraced terrain.** A
   physically-honest solar arc puts the sun straight up at noon, which lights
   every plateau uniformly and removes all riser shading at once — the island
   flattens into a pale blob exactly when someone is most likely to be looking.
   The arc is clamped into a raking range at every hour. Cozy games light for
   legibility, not astronomy.
2. **Erosion is a transport process, so the height distribution is
   bottom-heavy.** Quantising it directly put ~30% of land into band zero: one
   enormous flat sand plain. A sub-1 exponent before quantising rebalances it
   to ~18%. Safe, because it only decides where *land* sits; plant elevation
   still maps linearly to time remaining in world-Y.

### Phase 8 — done, with its gaps named

#### Checkpoint 2026-09-07 (second session): measured on the brief's own hardware

A real Edge window on this laptop, driven over the DevTools protocol
(`scratchpad/cdp.mjs`), turned out to have **WebGPU**, and its adapter is
**Intel gen-12lp - Iris Xe, the GPU Section 15 names**. Windows routes the
browser to the integrated GPU and ignores `powerPreference`, so every number
below is target-hardware, not the RTX 3050 the in-app pane uses over WebGL2.

Found and fixed:

- **The app booted on the WebGPU path for the first time.** Grass, flocks,
  sky, ink and bloom all rendered. Two warnings fixed: grass compiled once
  before its instance attributes existed (hidden until populated), and empty
  plant draws (hidden at zero instances). GPU timestamps needed
  `renderer.resolveTimestampsAsync` per frame; the HUD now shows real GPU ms
  on WebGPU.
- **The tier heuristic called Iris Xe "High"** - it read a compute limit that
  is 32 KB on everything. High presented a frame every **92 ms** there.
  Replaced by `tierForAdapter` (vendor/architecture: Intel integrated → Medium,
  Arc/NVIDIA/AMD/Apple → High, mobile vendors → Low), tested.
- **Medium missed the 60 fps budget on Iris Xe: 50 ms per frame (GPU 38 ms).**
  Ablation by reload (`?budget.*=` dev overrides, `core/config.ts`): the
  normal MRT of the ink cost 9 ms of GPU, bloom 8 ms of frame, the 2048 shadow
  map ~1 ms, grass ~5 ms per 100k blades. **Medium is now depth-only ink, a
  1024 shadow map and no bloom**, and with a **75% render scale presents at
  16.8 ms (60 fps, GPU 13.6 ms)**. Bloom on top costs the frame (25 ms), so
  the glow belongs to High. On the WebGL2 backend the same GPU is slower:
  58 ms baseline, 25 ms tuned.
- **Render scale** is a device setting (`setRenderScale`, slider in Settings,
  shown in the HUD as "internal WxH (75%)" so it is never mistaken for 1080p).
- **First-run frame benchmark** (`core/autoQuality.ts`, tested): measure
  presented frames, step the scale 1 → 0.85 → 0.75 → 0.66 until the frame
  fits, else record the tier below (`settings.autoTier`) for the next start.
  Skipped under a manual tier, dev overrides, or a hidden tab. **Not yet
  verified end to end in the app** - the verification script hung on
  navigation and its readings were from the previous page. First thing next
  session: run `autobench.mjs` cleanly, and check the StrictMode double-effect
  does not cancel the loop. Also: `benchmarkFrames` keeps one `onTiming` hook,
  so two concurrent callers clobber each other and the loser never resolves -
  make it a listener set before shipping the auto benchmark.
- **Erosion executed on a GPU for the first time**, and the CPU-vs-GPU table
  the brief asks for is real (Iris Xe, 256² grid): 65k droplets CPU 325 ms /
  GPU 183 ms (1.8x; the first call carries ~190 ms of pipeline compile),
  130k 567 / 121 ms (4.7x), 260k 1087 / 318 ms (3.4x). Divergence CPU vs GPU:
  band disagreement 5.1% / 4.2% / 3.6%, land 0.4%.
- **And then GPU erosion was removed from the isle's path on purpose.** The
  race that made it fast makes it non-deterministic: two boots from one seed
  would carve slightly different isles, and "this shape is permanent" is a
  promise. The seeded CPU walk carves 40k droplets in 140-200 ms here. The GPU
  path remains as the benchmark. This had been hidden by a bug: the compute
  device memo set a flag before awaiting the adapter, so the second concurrent
  caller (StrictMode's second boot effect) got null and the GPU branch never
  ran in development. Fixed by memoising the promise (`computeDevice.test.ts`).
- **Offline verified on the web**: the production build's service worker
  activated with 5 precached entries and the app reloaded fully with the
  network emulated offline (`offline.mjs`).
- Cold start on Iris Xe, WebGPU, dev server: Medium 1.39 s shell / 1.96 s isle;
  High 1.65 / 2.40 s.

#### Session 3, same day: the last two shaders run, the benchmark closes

- **`benchmarkFrames` now fans out to a listener set** instead of replacing
  the loop's timing hook; concurrent callers no longer clobber each other.
  The first-run benchmark effect hands its slot back when StrictMode cancels
  it during the settle wait, so it runs in development too.
- **First-run benchmark verified end to end** (`autobench.mjs`): from default
  settings it stepped 100 → 85 → 75 → 66% and persisted `renderScale: 0.66,
  benchmarked: true`; a fresh 180-frame reading at that scale is **16.7 ms
  median (60 fps), GPU 10.4 ms** on Iris Xe. One step lower than the isolated
  run: 75% sat within a millisecond of the tolerance and the 120 Hz panel
  rounded it to 25. That is the rule working, not failing.
- **Spectral ocean executed** (`render/oceanFFTGPU.ts`, `__tidewick.fft()`):
  spectrum pass matches the JS reference to 1e-5 (float32 trig); the Stockham
  inverse FFT matches a plain-JS O(N⁴) inverse DFT to **4.7e-9** at 32²; a
  full 256² transform (spectrum, 16 butterflies, resolve) costs **5.7 ms**,
  512² 19 ms, on Iris Xe. The sea that ships stays Gerstner: 5.7 ms is a third
  of the tuned frame budget for a difference invisible at diorama distance.
- **Compute flock executed** (`render/boidsGPU.ts`, `__tidewick.boids()`):
  twelve bindings, four pipelines on one explicit layout (with `layout: 'auto'`
  each entry point would only accept the bindings it reads), ping-pong state,
  homes uploaded per step from the same formula `birds.ts` uses. **50,000
  agents: 0.78 ms per step**; 10k 0.47, 100k 0.54 (throughput over 60 steps,
  first submit to `onSubmittedWorkDone`). Finite, every speed inside the band,
  furthest bird 107 m from centre, mean 15-17 m from its flock's home. The
  drawn flock stays CPU and small by art direction.
- CPU-side halves of both harnesses are unit-tested (`computeHarness.test.ts`):
  `Params` byte layout field for field, grid sizing, the Stockham pass plan,
  and the reference inverse DFT against a DC spectrum and a single plane wave.

- **The demo is recorded.** `tour.mjs` drives the real app over the DevTools
  protocol - founding ("Lantern Cove", a Keeper named Moss), the Placement
  Prep template through the palette and the settings sheet, the workspace and
  the DSA ladder's board, then Tab to the isle, an orbit, dawn to dusk through
  `__tidewick.hour`, a walk as the Keeper on real key events, and night -
  while `Page.startScreencast` streams JPEG frames (2,913 in 47.6 s). Pillow
  resamples them to a fixed rate. Dithered GIFs of a moving sea ran 17-42 MB;
  undithered quantisation suits flat toon colour and cut them by half:
  `docs/demo.gif` (isle only, 18 s, 400×225, 5.7 MB) and `docs/tour.gif`
  (the whole tour, 44 s, 8.7 MB), plus six 1280×720 stills from the same run
  as JPEGs in `docs/`. The README's first screen now shows the product.

#### Session 4: the Windows app, installed, and the logo

- **Logo** (`public/logo.svg`): a terraced isle at dusk with a lantern lit on
  its summit and the tide below - the isle's own palette, one ink, flat toon
  colour. Built so each terrace is a riser silhouette with its top face laid
  over it (the first cut drew full ellipses and their back rims striped every
  face). Rendered to PNG with headless Edge; `pnpm tauri icon public/logo.svg`
  regenerated every platform icon (`.ico`, Start-menu tiles, `.icns`, Android
  mipmaps), Pillow the PWA set plus a full-bleed maskable variant; the favicon
  is the SVG itself. The mark sits beside the wordmark on the home page and
  beside the isle's name in the workspace sidebar.
- **Windows app, built and installed on this laptop.** `pnpm tauri build` →
  `Tidewick_0.1.0_x64-setup.exe` (NSIS, per-user, 3.7 MB) and an MSI; the NSIS
  installer run silently put `tidewick.exe` (10 MB) in
  `%LOCALAPPDATA%\Tidewick` with Start-menu and Desktop shortcuts and an
  uninstall entry. Launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=9444` and inspected over CDP: `http://tauri.localhost`,
  **WebGPU path, adapter Intel gen-12lp**, no errors.
- **Found: the first launch of the new build opened blank.** The previous
  build had registered the web service worker inside WebView2; a fetch made
  from a worker on the desktop origin fails, so it served its cached shell,
  whose hashed module no longer existed, and the module request came back as
  HTML. Fixed three ways: `main.tsx` never registers a worker inside Tauri and
  unregisters any it finds; `sw.js` on the desktop origin exists only to delete
  its caches, unregister itself and reload its clients (so machines that ran
  the earlier build heal on their next start); and this laptop's stale WebView2
  profile (`%LOCALAPPDATA%\dev.tidewick.app`, 16 MB, mine from yesterday's
  launch) was removed.
- **Found: the first-run benchmark demoted the desktop app to Low on a shared
  GPU.** My Edge instance was still rendering the dev build on the same Iris Xe
  while the desktop app measured itself. A demotion now needs **two starts to
  agree** (`applyBenchmarkOutcome`, tested): one miss at the smallest scale is
  a strike that keeps 66% for the session and re-measures next start. On a
  free GPU the desktop app stepped 100 → 85 → 75 → 66% and settled at Medium:
  HUD 48 fps, 24.8 ms frame, 11.7 ms GPU at 1188×696. WebView2 presents more
  slowly than Edge at the same GPU cost (16.7 ms there), which is the
  compositor, not the isle.

Still open: the other-platform builds (macOS, Linux, Android, iOS), which need
their own hosts. Gate: typecheck clean, **669 tests / 41 files**, 4/4 shaders
naga-valid and 3/3 executed, names clean. No commits, by request.

**Landed and seen in the browser:**

- **Scenery.** Grass (`render/grass.ts`): one triangle per blade, random yaw,
  vertex-shader wind, tier-scaled 0 / 250k / 1M. Birds (`render/birds.ts`): a
  CPU flock with a spatial hash, in five distinct groups pulled toward drifting
  homes on a ring; a sky with hashed stars, a sun disc and a scrolling CPU
  cloud texture; a tier-gated bloom stage after the ink pass. Lanterns are
  self-lit through the node material's emissive slot and are the only thing
  bloom is thresholded to catch - at 0.78 the whole beach wore a halo.
- **The Keeper wears the founding-flow colours** (outfit → cloak, body → skin,
  hair → hood). The follow camera's default pitch was lowered from 0.42 to
  0.30 so the sky is in frame without dragging for it.
- **The workspace, dressed** (`workspace/theme.css`): warm paper by day, the
  island's night palette by dark, the season accent everywhere colour carries
  information, and the isle glyph beside its name in the sidebar.
- **The home page is dynamic**: one sentence about the day ("2 things growing,
  nothing due today"; "one in the shallows" where another product would say
  overdue), a season ring that fills, and every number counted from the
  workspace against the live clock (`islandDigest`).
- **Command palette** (`workspace/CommandPalette.tsx`, Ctrl+K): pages, rows,
  databases, text inside blocks, and the actions with no other keyboard home.
  Plain scan, deliberate ranking, no fuzzy matching.
- **Settings** (`workspace/SettingsPanel.tsx`): quality tier override, sound,
  volume, cloud cover, HUD on start - stored in `localStorage` because they
  describe the device, not the isle (`core/settings.ts`).
- **Starter packs as data** (`packs/placementPrep.ts`): Placement Prep, Weekly
  Review, Reading List. Applied through ordinary commands, one undo away from
  never having happened, dated relative to now so nothing arrives overdue.
- **Import and export** (`state/transfer.ts`): the whole workspace as JSON,
  byte-for-byte round-trippable and stamped with the schema; a page as
  Markdown, lossy on purpose.
- **Sound** (`sound/ambience.ts`): sea, wind and a lantern bell, synthesised.
  Off by default; the AudioContext is not created until asked.
- **PWA**: `public/manifest.webmanifest`, a hand-written `sw.js` (shell
  network-first, hashed assets cache-first), registered in production only.
- **`pnpm names`** (`tools/checkNames.mjs`): the grep the brief asks for, plus
  a structural check that `createWorkspace` defaults no name. In `pnpm check`.
- **`boids.wgsl.ts`**: the compute twin of the CPU flock, four dispatches with
  a hashed grid, naga-validated and - like every compute shader here - never
  executed.
- **Reduced motion reaches the isle** (`render/motion.ts`). Grass wind, the
  sea's swell, star twinkle and cloud drift all read one clock - TSL `time`
  times a uniform - and `prefers-reduced-motion` sets it to zero, live, from
  the media query's change event. Verified by pixel readback: advancing the
  clock three seconds changes 75% of the frame normally and 0.00% under
  reduced motion. The flock is thinned to a third rather than removed; plants
  still drift and lanterns still bloom, because those carry meaning.
- **The HUD reports agents and grass blades**, the two Section 15 counters it
  was missing.
- **Cold start is marked**, not estimated: `tidewick:interactive` when the
  shell renders, `tidewick:island` when the terrain lands; `__tidewick.boot()`
  reads both.
- **`benchmarkSubmit()`**: the frame measurement that works in a hidden pane.
  See "Measured".
- **God-rays: built, run, measured, and turned off.** `GodraysNode` sits in
  the outline pipeline behind a tier budget, retargets with the camera,
  follows the sun's colour and elevation, and compiled on WebGL2 first time.
  Pixel readback at strength 0.5: +22% mean luminance over 86% of the frame.
  Screenshots showed why that is the wrong kind of light: a grey veil over
  the whole isle from the diorama, and the same veil with a brighter sky at
  the Keeper's eye level, toward the sun and away from it. Crepuscular rays
  are shadow streaks in lit haze, and this isle has nothing tall enough to
  cast them. Every tier's budget is 0 and `config.test.ts` says so.

**Bugs fixed in this pass:**

- Home page lantern count was a stored counter only the Keeper incremented;
  tasks completed in a table never counted. Now `countLanterns()` - derived.
- Season "day N" was counted from founding, not from the season start.
- A bare `YYYY-MM-DD` was parsed as UTC midnight and formatted locally, showing
  the *previous day* for everyone west of Greenwich.
- Footpaths were a `Line` strip fed vertex pairs: every segment drawn twice
  and a stray connector between unrelated plants.
- `SetMeta` captured its before-value by reference - a revoked draft on undo.
- The isle bar's buttons all stacked on one corner (`.back-home` is absolutely
  positioned; inside the bar it must not be).
- The focus dock covered the sidebar footer in the workspace; it now sits
  bottom-right there.
- The starter pack passed block text as the block *id* (both strings, so it
  compiled) and produced pages of empty blocks whose ids were sentences.
- The first flock was 10,000 oversized black tetrahedra hiding the island; then
  a uniform confetti ring; the density test measured the homogenising and the
  fix was flock homes, not a different threshold.
- Cargo package renamed from `app` to `tidewick`.

**Measured, honestly:**

- Terrain, CPU path, cold worker: 414-443 ms at 48k droplets; warm 306-378.
  Medium now runs 40k droplets and the worker is spawned and warmed during
  renderer init. The 400 ms budget is met warm and missed cold by up to 10%.
- Frame work at **1920×1080**, WebGL2, laptop RTX 3050, idle machine, via
  `benchmarkSubmit(120)`: Medium **1.8 ms median CPU submit, 5.2 ms p95**;
  High (1M blades, 900 birds) **2.5 ms median, 12.5 ms p95**. Serialised
  CPU+GPU (`gl.finish()` after each frame) matched submit within 0.1 ms at
  both tiers: the GPU kept pace. 38 draw calls; 350k / 1.10M triangles. The
  earlier 24.8 ms at 740² during a Rust build is superseded.
- The first `benchmarkSubmit` reported 0.2 ms frames. It was timing the
  composite quad: a hidden document never ticks the renderer's animation loop,
  so the node frame never advanced and every post pass rendered its scene once
  in 125 iterations - 125 quads plus 37 scene draws is exactly the 162 draw
  calls it reported. `nodeFrame.update()` per iteration fixed it. A fence poll
  was tried next and spun forever, because a browser updates sync status from
  its event loop; `finish()` it is.
- Cold start, idle: Medium **0.46 s** to the shell, **1.21 s** to the isle;
  High 0.85 / 2.28 s. The same reload with the test suite's 37 workers
  running: 7.5 / 8.4 s - which is why the idle numbers are the ones reported.
- GPU memory at Medium, 1080p: 138 MB - 47 MB attributes (27 MB grass), 91 MB
  textures and render targets.

- **Tauri:** `pnpm tauri build` succeeded (3 m 41 s Rust build) and produced
  `tidewick.exe` plus an MSI and an NSIS installer. The binary was launched
  from the shell, showed a WebView2 process tree, and was closed cleanly - the
  first time the desktop shell has actually run in this project.
- **Presented frames are still not measured.** `benchmarkFrames()` waits for
  real frames and a hidden pane presents none; the only reading was seven
  samples at 8.3-8.6 ms at 736×745 before the window was minimised. With 2 ms
  of work per frame on this GPU the presented rate will be whatever vsync is -
  but that is an inference, and the budget names Intel Iris Xe, which this
  machine does not have.

**What Phase 8 cannot finish on this machine, and why:**

- The presented-frame rate: needs a visible window for a few seconds, and the
  budget's own hardware needs an Iris Xe laptop.
- The 50k-agent flock: the WGSL is written and validated; no WebGPU adapter
  here can run it, so the CPU path's 900 at High is the honest figure.
- macOS, Linux, Android and iOS: Tauri builds for the host OS only. Windows
  is built and launched; the others are configured and unbuilt, and "offline
  verified on every platform" is therefore verified on one.
- The 60-second demo GIF: nothing here can record the screen.

### Phase 7 — done

The loop that makes the island mean something.

**Sunlight lives in `WorkspaceState`, not in a game store.** That is Section 2
taken literally, and it pays immediately: Sunlight, seasons and the keepsake
pages are persisted, migrated, exported and undone by machinery that already
existed. Not one line of save code was written for the game. It also has an
awkward consequence which is the right trade - banking a focus session is
undoable, which is odd for elapsed time, but the alternative is a second
mutation path into the same tree and that is exactly the anti-pattern the brief
warns never gets merged.

**The measurement is the product.** `focus.ts` counts blurred and idle time
separately and never pays for either, and a session ends on *focused* time
rather than wall-clock: twenty-five minutes of which ten were in another window
is not a finished session, and saying otherwise would be the tool lying to its
user. Time is read from the wall clock each tick rather than accumulated from
frame deltas, because a background tab throttles rAF and summing deltas would
under-count exactly the case the blur rule exists to catch.

Measured against the Phase 7 gate:

| Criterion | Result |
|---|---|
| A 25-minute session produces Sunlight and visibly warms the light | **yes** — verified in the running app: sun blue 0.851 → 0.636, intensity +28%, sun rakes 0.590 → 0.486, fully reversible |
| Blurring the window fades the multiplier | **yes** — and returns *gradually*, asserted directly |
| A three-week-overdue task sits recoverable in the shallows | **yes** — decay reaches its floor at 21 days and stops; the plant is still there and still liftable |
| All six cozy guarantees enforced and unit-tested | **yes** — `guarantees.test.ts`, written adversarially |

The guarantees are tested by trying to break them: the tests hunt for the fail
state, try to farm the currency by clicking, try to make deletion cost
something, and pass only when they cannot. A comment saying "no fail state" is
worth nothing the day someone adds a plausible-looking penalty branch.

Three decisions worth recording:

1. **Spending Sunlight can never block a completion.** With an empty reserve
   the task still completes and the bloom is simply plainer. Gating real work
   behind a resource would be a fail state wearing a friendly hat.
2. **The bloom is presentation, not derivation.** The snapshot says a task is
   done; it must never say "done 0.4 seconds ago", because that puts a clock
   inside a pure function. The Stage notices a plant *became* a lantern between
   two snapshots and eases its stage value — which needs no new instance
   attribute at all, since the shader already ramps colour and scale across
   that number.
3. **The Harvest Festival is computed, never scheduled.** A local-first app may
   not be running when a season ends, so there is no timer to miss: the
   festival is simply true the next time you look, and waits until you are
   ready rather than having silently happened while the laptop was shut.

### Phase 7 — found while building

- **The derive worker permanently broke on an empty workspace.** `derive()`
  returned the module-level `EMPTY_SNAPSHOT` singleton when there were no
  databases; the worker transfers every typed array, which *detaches* the
  buffers in worker scope, so the second empty derive threw `DataCloneError`
  and the island silently stopped updating for the rest of the session. It only
  bit a workspace with no databases — which is a brand-new one, which is the
  first thing a new user sees. Found by reading the browser console, not by a
  test: nothing in the suite posts a message.
- **The season palette had never reached the island.** `this.season =
  seasonAt(0)` was set once in the constructor and never updated, so the four
  palettes and the cross-fade existed but only the DOM accent used them.
- **The decay curve did the opposite of its comment.** It claimed the first
  days away barely register and used an ease-*out*, which falls fastest at the
  start: a weekend away cost 8% of the island's warmth. Smoothstep now costs 1%
  for a weekend, 12% for a week, and reaches the floor at three weeks.

### Phase 6 — done

The Keeper walks the isle, and the isle answers back.

**The stack is layered so the interesting parts are testable without a GPU.**
`controller.ts` has no three.js import at all - it takes an input struct and a
`GroundSampler`, which is why it could be tested against a synthetic staircase
before the render layer existed. `system.ts` assembles movement, animation,
reach and carrying; `render/keeper.ts` only draws.

- **Movement** applies each axis separately, so walking into a cliff at an angle
  slides along it instead of stopping dead.
- **`stepOffset` is 2.6**, deliberately generous. A band on this island is 2.18
  units, so a realistic step height would make most of the isle unreachable.
- **The follow camera** is a spring arm that marches the heightfield rather than
  raycasting the terrain mesh - the heightfield already answers "how high is the
  ground here" in one lookup.
- **Interaction is the inverse of the elevation mechanic.** `elevationFor` turns
  a date into a height; `dueDateForPosition` turns a height back into a date.
  Setting a plant down *is* the reschedule.

Measured against the Phase 6 gate:

| Criterion | Result |
|---|---|
| Walk the full island without getting stuck | **yes** — flood fill from the shore under the Keeper's own step rule reaches 100% of land cells, summit included, on six seeds |
| Camera never clips terrain | **yes** — asserted from 24 angles inside a bowl with walls on every side |
| Tend a plant to complete its task | **yes** — verified in the running app: "Tend Two Sum" moved the real row To-do → Complete |
| Carry an overdue plant uphill and watch the due date update | **yes** — "Lift Two Sum from the shallows", carried inland, due date 2026-09-02 → 2026-11-18 in the store |

Three decisions worth recording:

1. **The Keeper emits intents, not commands.** `system.ts` never imports the
   store; `keeper/commands.ts` turns `onTend`/`onReschedule` into the *same*
   `SetPropertyValue` the table UI dispatches. That is what keeps Section 2
   true - there is no island-only mutation path, so undo works identically from
   either half.
2. **The straight-line walk test was replaced by a reachability flood fill.**
   Walking test rays cannot answer "can you get stuck": a ray that stops at a
   cliff is the controller working, and a ray that travels far may be sliding
   along a wall it never climbs. A real player steers; a straight line does not.
3. **The overview toggle is `V`, not `Tab`.** The app shell already owns Tab,
   and two handlers calling `preventDefault` on one key is how one of them
   silently stops working.

**What is missing, plainly:** there is no rigged character and no animation
clips. The six-state machine, its transitions and its blend weights are real;
the poses they drive are computed from a stride phase rather than sampled from
a curve. Swapping in a rigged GLB means replacing `render/keeper.ts` and
`poseFor()`, and nothing else in the stack changes.

### Phase 6 — found while building

Two defects that predate the Keeper, both found because it exercised paths the
existing tests did not:

- **Undo crashed on any object-valued property.** `SetPropertyValue` captured
  its previous value *during* an Immer produce, so a date, multi-select or file
  list was captured as a live draft proxy; the proxy is revoked when the produce
  ends, and writing it back threw `Cannot perform 'get' on a proxy that has been
  revoked`. Reachable from the ordinary date picker - set a date, change it,
  press Ctrl+Z. Fixed with `clonePropertyValue`; `cloneBlock` already existed
  for exactly this reason and the database commands never got the same
  treatment.
- **The band palette inverted its own histogram.** Its comment claimed the stops
  followed the measured distribution; measuring showed the desaturation ramp
  captured 42.7% of the island, including the two largest bands, while the pale
  summit colour it was reserving room for covered 1% and the top band held no
  cells. Retuned, and `palette.test.ts` now asserts the green fraction across
  six seeds rather than trusting a look.

A third was self-inflicted and worth the same note: the **query performance test
asserted an absolute millisecond budget** and duly failed the moment the suite
grew enough to load the machine. Rewritten as a scaling ratio, which contention
cancels out of. Verifying it by reintroducing the original bug then showed the
test had *never* exercised the tie-break comparator it claimed to guard, because
the sort key was unique. Both now checked in each direction.

### Phase 5 — done

**The formula engine** (`src/formula/`) is the largest single artifact in the
project and the one written most carefully.

- **Hand-written lexer and recursive-descent parser.** Generated would have been
  shorter and would say "unexpected token at 14"; every error here carries a
  span, so the editor underlines the characters and says what it expected. A
  bare `Status` is told to write `prop("Status")`.
- **`prop()` takes a string literal only.** A computed column name would make
  the dependency graph undecidable, and undecidable means no cycle detection.
- **Five types**, narrow coercion. Arithmetic on text is an error with a
  message rather than a silent zero: a spreadsheet that turns "" into 0 is
  wrong in a way nobody notices for months.
- **`if` does not evaluate the branch it skips**, so
  `if(empty(prop("X")), 0, 100 / prop("X"))` is writable.
- **Cycle detection at edit time**, against the graph the edit *would* create,
  so nothing invalid reaches the store. Iterative DFS with three-colour
  marking - a recursive version is half the length and blows the stack on the
  deep chain an adversarial user is holding.
- **Topological incremental recalculation**: one pass, each formula after
  everything it reads.

Other Phase 5 work: **Timeline/Gantt** with drag, edge-resize, four zoom levels
and dependency arrows drawn from relations; **bidirectional relations** that
maintain the inverse through every edit; **footpaths** on the island derived
from those relations, with traffic proportional to recent activity; and a
**Gerstner ocean** with analytic normals, shore-damped amplitude and a foam
band at the waterline.

Measured against the Phase 5 gate:

| Criterion | Result |
|---|---|
| Cyclic formula rejected at edit time, no hang | **yes** - names the loop; a 12,000-deep chain detects in < 500 ms |
| 1,000-row recalculation under 50 ms | **yes** - three chained formulas per row, 3,000 evaluations |
| Timeline drag moves the plant on the slope live | commits during the drag, not on release |
| Ocean with correct shore foam | Gerstner, 16,641 verts, 22 draw calls total |

Two decisions worth recording:

1. **Footpaths are built on the CPU, unlike plants.** The opposite choice, for
   a reason: a path is a curve between two *moving* points, and a vertex shader
   has no per-instance slot for the second endpoint. Paths also change far less
   often than the clock ticks, so rebuilding on snapshot change is cheap.
2. **`SetRelation` snapshots both sides rather than recomputing the inverse.**
   Recomputing looks tidier and is wrong: an edit that both adds and removes
   links is not reversible from the new value alone, and undo would leave
   dangling references on the far side.

### Phase 5 — remaining

The FFT ocean is **written and naga-validated but never executed** - same
blocker as the GPU erosion. Gerstner is what actually runs. Rollups still
evaluate eagerly in `query.ts` rather than through the formula dependency
graph; correct, but it recomputes more than it needs to.

### Phase 4 — done

The thesis, running. `derive(WorkspaceState) -> IslandSnapshot` is pure: no
clock, no randomness, nothing outside its arguments. Databases become regions,
rows become plants, and a due date becomes an elevation.

**A plant's position is deliberately not derived.** Elevation is a function of
how long is left before a task is due, which changes every second - baking a
position would mean re-deriving the world constantly just to animate the drift.
Instead each instance carries its due date, and the vertex shader places it for
whatever `now` currently is. Downhill drift costs one uniform write per frame,
`derive()` stays clock-free and therefore testable, and the island cannot fall
out of step with the workspace because it never held a position to fall out of
step with.

The lookup that makes that possible is `render/terrain/profile.ts`: the terrain
is reduced once to a 64x48 table of *at this angle, at this elevation, here is
the radius and the ground height*. One texture fetch places a plant.

Measured in the browser, against the Phase 4 gate:

| Criterion | Result |
|---|---|
| Completing a task lights its lantern within one frame | **4.8-7.2 ms** dispatch to island, stage 0 to lantern |
| Only dirty ranges are uploaded | **28 bytes, 1 instance** of 8 - one instance is 7 floats |
| Clicking a plant opens its page | **6/6** on-screen plants picked exactly; empty sea returns null |
| A task due in 7 days descends over 7 days | linear in time remaining, unit-tested day by day |
| Undated tasks sit in the flat meadow | level 0.34, off the gradient at any `now` |

Three bugs worth recording:

1. **The waterline fallback.** `buildRadialProfile` used `height === 0` to mean
   "no crossing found on this ray". At the waterline the target *is* zero and
   the match is legitimate - so every task due today was flung to the middle of
   the island and buried inside the peak. The data looked perfect and the isle
   looked empty. Now a `found` flag, and a regression test.
2. **`vec3()` with no arguments** is not a usable variable to assign into, so
   the If/Else colour node silently produced flat white for every plant -
   indistinguishable from a material that never received a colour node.
   Rewritten as a plain expression; the GPU-picking branch went with it, since
   picking is done on the CPU against the same maths.
3. **Plants sized for botany rather than for the camera.** A 1.8 m sapling is
   about two pixels tall from 300 m. They are map markers as much as scenery.

### Phase 4 — remaining

Footpaths from relations, critters, region biome palettes, and the bloom-and-
light animation on completion (the state is right; the *sequence* is Phase 7).

### Phase 3 — done

**A row is a Page.** Not a shortcut - it is what makes Section 4's mapping work.
The brief maps "Page / Task" to a plant and "Database / Project" to a region; if
rows were their own entity type, every derivation would need two code paths for
the same concept. A row therefore has a title, a body of blocks and a property
bag, and the island will not care which of those a plant grew from.

- **Sixteen property types** (`state/database.ts`), with the PropertyDef as the
  single source of truth for interpreting a raw stored value. A tagged union
  would repeat the type in every cell of every row and make changing a property
  type a rewrite rather than a reinterpretation.
- **Query engine** (`db/query.ts`) - compound AND/OR filter groups nested to any
  depth, multi-level sorts, grouping. Pure and React-free, because Phase 4 calls
  it from inside the derivation worker: a Board column and a region of the isle
  must be the same query or the two halves disagree about reality.
- **Nineteen database commands**, all invertible. Deleting a property snapshots
  every value in every row - restoring an empty column would be a data loss
  dressed up as an undo.
- **Five views**: Table (windowed), Board (drag writes back), Calendar (drag to
  reschedule), Gallery, List. Saved and named, so a filter survives a reload.
- **Filter, sort, group and property panels**, every change through UpdateView
  and therefore persisted and undoable.

Measured against the Phase 3 gate, in the browser:

| Criterion | Result |
|---|---|
| 8 property types, 500 rows | 9 types, 506 rows |
| Board drag writes back | yes - card moved column and the property changed |
| Filters compose with AND/OR | yes, including nested groups |
| Views under 16 ms per frame | query 0.2 ms; Table mounts 34 of 506 rows |

Three decisions worth keeping:

1. **An empty filter group matches everything.** The textbook alternative - an
   empty AND vacuously true, an empty OR vacuously false - means adding a group
   hides every row until you finish configuring it.
2. **Empty values sort last in both directions.** Treating them as "smallest"
   floats every unfilled row to the top the moment you reverse a sort.
3. **Status and Select sort by the option order the user arranged**, not
   alphabetically. Alphabetical puts Complete before To-do, which is nonsense.

### Findings from Phase 3

One timing assertion in `query.test.ts` caught three separate performance bugs
that were invisible by inspection, together costing 8 ms on 500 rows:

1. `rows.indexOf()` inside the sort comparator - O(n^2 log n).
2. `findProperty()` per comparison - a linear scan of the schema, per compare.
3. `localeCompare(a, undefined, options)` builds a fresh `Intl.Collator` on
   every call, and a 500-row sort makes about 4,500 of them.

Fixed, and now under 2 ms. The threshold is set against the frame budget with
headroom rather than tuned to the fastest observed run - a timing test that
fails under load is one people learn to ignore.

### Findings from Phase 2

1. **The browser automation in this environment cannot send keyboard input.**
   Its key events arrive with `key: ""`, `code: ""` and `which: 0`, so Enter,
   Tab and Backspace are indistinguishable from each other and from nothing.
   Every keyboard behaviour in the editor is therefore unverifiable by clicking
   around, which is why `BlockEditor.test.tsx` exists and why the browser check
   drives the page with synthetic `KeyboardEvent`s instead.
2. **`structuredClone` cannot clone an Immer draft.** Commands snapshot blocks
   from inside a producer, where every object is a revocable Proxy, and the
   structured-clone algorithm refuses proxies outright. Deleting or merging a
   block threw `DataCloneError` in production; the tests caught it before a
   person did. `cloneBlock` copies fields explicitly instead.
3. **A failed load must not look like an empty one.** `loadMostRecent` returned
   `null` for both, so a transient read failure founded a second workspace,
   saved it, and - being the most recent row - shadowed the real island on every
   subsequent launch. It now returns a tri-state and the caller decides.

### Phase 1 — open gaps

1. **GPU erosion is written and validated but never executed.** No machine
   available to this project has a WebGPU adapter: `navigator.gpu` exists in the
   dev browser but `requestAdapter()` returns `null`. The shader passes `naga`
   validation, so it is well-formed WGSL and the bindings type-check, but the
   algorithm has not run. **Needs one session on a WebGPU-capable browser.**
2. **Terrain generation misses the 400 ms budget on the CPU path** — ~476 ms.
   See the benchmark table in the README.
3. **Frame rate is unmeasured.** The dev browser pane does not composite, so
   `requestAnimationFrame` is throttled to ~4 Hz and the HUD's fps figure is
   meaningless there. `renderAsync` returns on command submission rather than
   GPU completion, so the direct-render harness does not close the gap either.
   Needs a real display.
4. Tauri v2 desktop binary **builds clean** (`src-tauri/target/release/app.exe`,
   Windows, 8.2 MB) with a strict CSP that forbids network access outright, so
   the local-first promise is enforced rather than merely stated. Not yet
   launched and clicked through, and the Cargo package is still named `app`
   rather than `tidewick`, so the executable name needs fixing.
5. Inverted-hull outlines are not built. They are for the Keeper and props
   (Phase 6); terrain deliberately uses the screen-space pass only.

### Phase 2 — done

**Editor core: custom block model, not TipTap.** This reverses the earlier
recommendation, and the reason is architectural rather than aesthetic.
ProseMirror owns its own transaction system and its own undo history. Section 2
forbids a second source of truth and Section 11 requires one Command stack
shared with the island, so TipTap means either reconciling two histories - the
exact failure the architecture exists to prevent - or wrapping every PM
transaction in a Command anyway, which is paying for the library and still
writing the hard part. There is a derivation cost too: blocks inside a
ProseMirror document are opaque to `derive()`, so a checklist item becomes a bud
on a plant only by walking serialised JSON, and the dirty set degrades from
per-block to per-page.

Built:

- **Block model** (`state/blocks.ts`) - normalised entities, arbitrary nesting,
  inline marks as half-open ranges rather than a node tree, so overlapping bold
  and italic need no restructuring.
- **Sixteen commands** (`state/blockCommands.ts`) covering pages, insert,
  delete, split, merge, indent, outdent, move, type change, to-dos and toggles.
  Every one is invertible, and every test that mutates also undoes.
- **Editor** (`editor/`) - contenteditable per block, slash menu with fuzzy
  search, nine Markdown shortcuts, Enter/Backspace/Tab semantics, keyboard
  navigation between blocks, inline marks via the modifier shortcuts.
- **Workspace shell** - sidebar page list, undo/redo, `Tab` toggles the two
  halves, `Escape` returns home.
- **Persistence** - schema v2 with a forward migration.

### Phase 3 — remaining

Timeline view (Phase 5, alongside the island seen in profile), the formula
engine (Phase 5), relation inverse auto-creation, and drag-to-reorder rows.

### Phase 2 — remaining

Drag-to-reorder with a drop indicator, structure-preserving copy/paste, external
Markdown and HTML paste, page mentions, date mentions, and the toggle-list
collapse animation.

---

## Architecture rules (non-negotiable, from Section 11)

- Every mutation is a **Command object** with `apply` and `invert`. One mutation
  path, shared by the DOM interface and the Keeper.
- `derive()` is **pure, side-effect free, worker-thread and incremental**.
- The GPU bridge uploads **dirty ranges only**.
- Persistence is **write-behind and debounced**.
- If a function named `syncIslandWithTasks` ever appears, it is a bug.

---

## Notes carried forward

**WebGL2 has no compute shaders.** TSL falls back for *materials*;
`renderer.compute()` requires the WebGPU backend. Every compute workload
therefore needs a declared CPU or vertex-stage strategy for the fallback path,
not a second shader nobody maintains. Current plan:

| Workload | WebGPU | WebGL2 fallback |
|---|---|---|
| Erosion | WGSL droplets, standalone device | CPU in a worker (already the reference implementation) |
| Ocean (Phase 5) | IFFT compute | Gerstner sum-of-sines |
| Vegetation (Phase 8) | Indirect draw + compute cull | Instanced, coarse per-chunk CPU cull, reduced count |
| Boids (Phase 8) | 50k, spatial hash | CPU worker, ~5k, fireflies only |

**Erosion runs on its own `GPUDevice`, not the renderer's backend.** It needs no
canvas. This means it still runs on machines that expose WebGPU for compute but
fail to create a WebGPU *canvas context* — a real configuration, and one that
tying erosion to the render backend would have thrown away.

**Parallel droplet erosion is racy by construction.** WGSL has no float atomics,
so the heightmap is fixed-point `i32` with `atomicAdd`. Additions commute, so
totals are right, but read-during-update ordering varies per device — meaning
CPU and GPU do *not* produce byte-identical heightfields. `runErosionBenchmark`
measures how much of that divergence survives downsampling, smoothing and
quantisation into 12 bands, which is the only figure the player can perceive.
Unmeasured until a WebGPU machine is available.

**CPU and GPU use identical droplet counts and grids.** The droplet count is set
by what the CPU can afford, not by what the GPU could manage, so that the same
workspace grows the same island on every device. What the GPU buys is headroom
to re-erode when a project is added — not a different terrain.
