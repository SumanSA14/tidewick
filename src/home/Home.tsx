import { useEffect, useMemo, useRef, useState } from 'react'
import type { DaylightState } from '@/core/daylight'
import { greetingFor, toHex } from '@/core/daylight'
import { SEASON_LENGTH_DAYS } from '@/core/config'
import { seasonAt } from '@/render/palette'
import type { WorkspaceState } from '@/state/types'
import { SetMeta, SetKeeperName, SetKeeperColour } from '@/state/commands'
import { useWorkspaceStore } from '@/state/store'
import { countLanterns, islandDigest } from '@/island/derive'
import { seasonProgress } from '@/loop/seasons'

/**
 * The home page.
 *
 * It is a *page*, not a splash screen: the island behind it is the real, live,
 * running scene, lit by the actual time of day, and it keeps rendering the
 * whole time you are here. Nothing on this screen is a picture of the product.
 *
 * The founding flow deliberately does not let you type your way to a different
 * island. The terrain seed hashes the workspace id, not the name, so renaming
 * your isle later cannot bulldoze it - which means the shape has to be settled
 * at founding time and never again. "Show me another" rolls a new id and
 * regrows the land; once you begin, that island is yours permanently.
 */

export interface HomeProps {
  workspace: WorkspaceState
  daylight: DaylightState | null
  islandReady: boolean
  onEnter(): void
  onOpenWorkspace(): void
  onReshape(): void
}

const KEEPER_SWATCHES = {
  body: ['#f0d3b4', '#e0b48c', '#c08e63', '#8d5f42', '#5d3c2a'],
  hair: ['#2c2320', '#4a3b32', '#7b5230', '#b98a4c', '#d8d2c4'],
  outfit: ['#3f8fa8', '#5f9e6a', '#b8804a', '#8a6fa8', '#c2695f'],
}

export function Home({ workspace, daylight, islandReady, onEnter, onOpenWorkspace, onReshape }: HomeProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const { meta } = workspace
  const season = seasonAt(meta.seasonIndex)

  const [step, setStep] = useState<'isle' | 'keeper'>('isle')
  const [isleDraft, setIsleDraft] = useState(meta.isleName)
  const [keeperDraft, setKeeperDraft] = useState(meta.keeper.name)
  const isleInputRef = useRef<HTMLInputElement | null>(null)

  const founding = !meta.onboarded

  useEffect(() => {
    if (founding && step === 'isle') isleInputRef.current?.focus()
  }, [founding, step])

  // A live clock, so the page is never stale while you sit on it.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])

  // The accent is the season's, warmed toward whatever colour the sky is right
  // now. Both halves of the product read from the same source, so the DOM and
  // the island can never disagree about what colour the evening is.
  const accent = useMemo(() => {
    if (!daylight) return season.accent
    return blend(season.accent, toHex(daylight.skyHorizon), 0.28)
  }, [season.accent, daylight])

  const greeting = daylight ? greetingFor(daylight.phase) : 'Welcome'

  const daysTended = Math.max(0, Math.floor((Date.now() - meta.createdAt) / 86_400_000))
  // Day of the *current* season, not of the isle's whole life. The earlier
  // `daysSinceFounding % SEASON_LENGTH_DAYS` happened to agree until the first
  // Harvest Festival moved the season start, and then drifted forever after.
  const seasonDay = Math.min(SEASON_LENGTH_DAYS, Math.floor(seasonProgress(workspace, Date.now()).daysElapsed) + 1)
  // Derived, never stored: the count on the page and the lanterns on the hill
  // come from the same function, so they cannot disagree.
  const lanterns = useMemo(() => countLanterns(workspace), [workspace])
  // What the day holds, counted from the workspace against the live clock so
  // the page is never stale while you sit on it.
  const digest = useMemo(() => islandDigest(workspace, now.getTime()), [workspace, now])
  const seasonFraction = useMemo(
    () => seasonProgress(workspace, now.getTime()).progress,
    [workspace, now],
  )

  const style = { '--accent': accent } as React.CSSProperties

  const commitIsle = () => {
    const name = isleDraft.trim()
    if (!name) return
    dispatch(new SetMeta('isleName', name, 'Name the isle'))
    setStep('keeper')
  }

  const begin = () => {
    const name = keeperDraft.trim()
    if (name) dispatch(new SetKeeperName(name))
    dispatch(new SetMeta('onboarded', true, 'Found the isle'))
    onEnter()
  }

  return (
    <div className="home" style={style} data-founding={founding || undefined}>
      <div className="home__scrim" aria-hidden="true" />

      <div className="home__panel">
        <p className="home__wordmark">
          <img className="home__mark" src="/logo.svg" alt="" width="26" height="26" />
          <span>Tidewick</span>
        </p>

        {founding ? (
          step === 'isle' ? (
            <FoundIsle
              value={isleDraft}
              onChange={setIsleDraft}
              onCommit={commitIsle}
              onReshape={onReshape}
              inputRef={isleInputRef}
              islandReady={islandReady}
            />
          ) : (
            <DressKeeper
              name={keeperDraft}
              colours={meta.keeper.colours}
              onName={setKeeperDraft}
              onColour={(slot, value) => dispatch(new SetKeeperColour(slot, value))}
              onBack={() => setStep('isle')}
              onBegin={begin}
            />
          )
        ) : (
          <Returning
            greeting={greeting}
            isleName={meta.isleName}
            keeperName={meta.keeper.name}
            now={now}
            seasonName={season.name}
            seasonDay={seasonDay}
            daysTended={daysTended}
            lanterns={lanterns}
            focusMinutes={Math.round(meta.focusMinutes)}
            seasonFraction={seasonFraction}
            digest={digest}
            onEnter={onEnter}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
      </div>

      <p className="home__hint" aria-hidden="true">
        Drag to orbit &middot; scroll to zoom &middot; <kbd>F3</kbd> for stats
      </p>
    </div>
  )
}

// --- founding --------------------------------------------------------------

function FoundIsle({
  value, onChange, onCommit, onReshape, inputRef, islandReady,
}: {
  value: string
  onChange(v: string): void
  onCommit(): void
  onReshape(): void
  inputRef: React.RefObject<HTMLInputElement | null>
  islandReady: boolean
}) {
  return (
    <>
      <h1 className="home__title">An isle has risen.</h1>
      <p className="home__lede">
        It grew from nothing but a name and a seed. Give it yours, or ask the
        sea for another &mdash; once you begin, this shape is permanent.
      </p>

      <form
        className="home__form"
        onSubmit={(e) => {
          e.preventDefault()
          onCommit()
        }}
      >
        <label className="home__label" htmlFor="isle-name">Name your isle</label>
        <input
          id="isle-name"
          ref={inputRef}
          className="home__input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Somewhere quiet"
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />

        <div className="home__actions">
          <button type="submit" className="btn btn--primary" disabled={!value.trim()}>
            Continue
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onReshape}
            disabled={!islandReady}
          >
            {islandReady ? 'Show me another' : 'Growing…'}
          </button>
        </div>
      </form>
    </>
  )
}

function DressKeeper({
  name, colours, onName, onColour, onBack, onBegin,
}: {
  name: string
  colours: { body: string; hair: string; outfit: string }
  onName(v: string): void
  onColour(slot: 'body' | 'hair' | 'outfit', value: string): void
  onBack(): void
  onBegin(): void
}) {
  return (
    <>
      <h1 className="home__title">Someone should tend it.</h1>
      <p className="home__lede">
        You will walk the isle as the Keeper. Nothing here is fixed &mdash; you
        can change any of it later.
      </p>

      <form
        className="home__form"
        onSubmit={(e) => {
          e.preventDefault()
          onBegin()
        }}
      >
        <label className="home__label" htmlFor="keeper-name">Name your Keeper</label>
        <input
          id="keeper-name"
          className="home__input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Anyone at all"
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
        />

        {(['body', 'hair', 'outfit'] as const).map((slot) => (
          <fieldset className="swatches" key={slot}>
            <legend className="home__label">{slot}</legend>
            <div className="swatches__row">
              {KEEPER_SWATCHES[slot].map((c) => (
                <button
                  key={c}
                  type="button"
                  className="swatch"
                  style={{ background: c }}
                  aria-label={`${slot} colour ${c}`}
                  aria-pressed={colours[slot].toLowerCase() === c.toLowerCase()}
                  data-selected={colours[slot].toLowerCase() === c.toLowerCase() || undefined}
                  onClick={() => onColour(slot, c)}
                />
              ))}
            </div>
          </fieldset>
        ))}

        <div className="home__actions">
          <button type="submit" className="btn btn--primary">Begin</button>
          <button type="button" className="btn btn--ghost" onClick={onBack}>Back</button>
        </div>
      </form>
    </>
  )
}

// --- returning -------------------------------------------------------------

function Returning({
  greeting, isleName, keeperName, now, seasonName, seasonDay, daysTended, lanterns, focusMinutes,
  seasonFraction, digest, onEnter, onOpenWorkspace,
}: {
  greeting: string
  isleName: string
  keeperName: string
  now: Date
  seasonName: string
  seasonDay: number
  daysTended: number
  lanterns: number
  focusMinutes: number
  seasonFraction: number
  digest: ReturnType<typeof islandDigest>
  onEnter(): void
  onOpenWorkspace(): void
}) {
  const clock = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <>
      <p className="home__greeting">
        {greeting}{keeperName ? `, ${keeperName}` : ''}. <span className="home__clock">{clock}</span>
      </p>
      <h1 className="home__title">{isleName || 'Your isle'}</h1>

      <p className="home__today">{describeDay(digest)}</p>

      <dl className="stats">
        <Stat
          label="Season"
          value={seasonName}
          sub={`day ${seasonDay}`}
          ring={seasonFraction}
        />
        <Stat label="Days" value={daysTended === 0 ? 'first' : String(daysTended)} sub="on the isle" />
        <Stat label="Lanterns" value={String(lanterns)} />
        <Stat
          label="Focus"
          value={focusMinutes >= 60 ? `${Math.floor(focusMinutes / 60)}h` : `${focusMinutes}m`}
        />
      </dl>

      <div className="home__actions">
        <button type="button" className="btn btn--primary" onClick={onEnter}>
          Enter the isle
        </button>
        <button type="button" className="btn btn--ghost" onClick={onOpenWorkspace}>
          Open workspace
        </button>
      </div>
    </>
  )
}

function Stat({ label, value, sub, ring }: { label: string; value: string; sub?: string; ring?: number }) {
  return (
    <div className="stats__item">
      <dt className="stats__label">{label}</dt>
      <dd className="stats__value">
        {ring !== undefined && <SeasonRing fraction={ring} />}
        {value}
        {sub && <span className="stats__sub">{sub}</span>}
      </dd>
    </div>
  )
}

/**
 * How far through the season. A ring that fills, never one that drains: the
 * same information, the opposite feeling, and Section 17 forbids countdown
 * urgency anywhere.
 */
function SeasonRing({ fraction }: { fraction: number }) {
  const r = 6.5
  const c = 2 * Math.PI * r
  return (
    <svg className="stats__ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} className="stats__ring-track" />
      <circle
        cx="8" cy="8" r={r}
        className="stats__ring-fill"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
      />
    </svg>
  )
}

/**
 * One sentence about today, from the digest.
 *
 * Plain and specific, and never alarmed: "two in the shallows" is where the
 * word "overdue" would go in another product. Section 3.3 - rescue, not
 * failure - and Section 17's ban on urgency both land in this one function.
 */
function describeDay(d: ReturnType<typeof islandDigest>): string {
  const parts: string[] = []
  if (d.dueToday > 0) parts.push(d.dueToday === 1 ? 'one thing due today' : `${d.dueToday} things due today`)
  if (d.inShallows > 0) parts.push(d.inShallows === 1 ? 'one in the shallows' : `${d.inShallows} in the shallows`)
  if (parts.length === 0) {
    if (d.growing + d.meadow === 0) {
      return d.lanterns > 0 ? 'Everything you planted has bloomed.' : 'The isle is waiting for its first seed.'
    }
    const growing = d.growing + d.meadow
    return growing === 1 ? 'One thing growing, nothing due today.' : `${growing} things growing, nothing due today.`
  }
  const sentence = parts.join(' and ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.'
}

// --- helpers ---------------------------------------------------------------

/** Blend two #rrggbb strings. Used to warm the season accent toward the sky. */
function blend(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const to = (x: number) => Math.round(x).toString(16).padStart(2, '0')
  return `#${to(pa[0] + (pb[0] - pa[0]) * t)}${to(pa[1] + (pb[1] - pa[1]) * t)}${to(pa[2] + (pb[2] - pa[2]) * t)}`
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}
