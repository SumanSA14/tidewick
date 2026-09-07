import { useRef, useState } from 'react'
import type { QualityTier } from '@/core/config'
import type { DeviceSettings } from '@/core/settings'
import { PACKS, type Pack } from '@/packs/placementPrep'
import type { ImportResult } from '@/state/transfer'
import './settings.css'

/**
 * Settings, templates, and the way out.
 *
 * One quiet panel for three things that have nowhere else to live: the device
 * settings (tier, sound, clouds, HUD), the starter packs, and import/export.
 * Deliberately not a preferences *screen* - it slides in, does its job, and
 * leaves the isle visible behind it.
 *
 * Nothing here reaches the store directly. Every action is a callback the app
 * turns into a command or a device-setting write, which keeps this a pure
 * view and keeps the two kinds of state - workspace and device - from being
 * confused by the code that shows them side by side.
 */

export interface SettingsPanelProps {
  open: boolean
  settings: DeviceSettings
  detectedTier: QualityTier
  /** The tier the renderer is actually running. Changing it needs a reload. */
  activeTier: QualityTier
  isleName: string
  onChange(next: DeviceSettings): void
  onClose(): void
  onApplyPack(pack: Pack): void
  onExportJson(): void
  onExportMarkdown(): void
  onImport(text: string): ImportResult
  /** True while a page is open, so Markdown export has something to export. */
  hasPage: boolean
}

const TIERS: Array<{ id: QualityTier; label: string; hint: string }> = [
  { id: 'low', label: 'Low', hint: 'No grass, a small flock. Runs on a phone.' },
  { id: 'medium', label: 'Medium', hint: '250k blades of grass, depth-only ink. The integrated-graphics tier; holds 60 fps on Iris Xe at 75% render scale.' },
  { id: 'high', label: 'High', hint: 'A million blades, bloom, deeper erosion.' },
  { id: 'ultra', label: 'Ultra', hint: 'For a desktop GPU with nothing better to do.' },
]

export function SettingsPanel({
  open, settings, detectedTier, activeTier, isleName,
  onChange, onClose, onApplyPack, onExportJson, onExportMarkdown, onImport, hasPage,
}: SettingsPanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [confirmPack, setConfirmPack] = useState<Pack | null>(null)

  if (!open) return null

  const set = <K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]) =>
    onChange({ ...settings, [key]: value })

  // Automatic means: whatever the first-run benchmark settled on, else detection.
  const autoTier = settings.autoTier ?? detectedTier
  const chosenTier = settings.tier ?? autoTier
  const needsReload = chosenTier !== activeTier

  const pickFile = () => fileRef.current?.click()
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    const result = onImport(text)
    setImportMessage(result.ok ? `Restored ${file.name}.` : result.reason)
  }

  return (
    <div className="settings__scrim" onMouseDown={onClose} role="presentation">
      <aside
        className="settings"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings__head">
          <h2 className="settings__title">Settings</h2>
          <button type="button" className="settings__close" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <section className="settings__section">
          <h3 className="settings__label">Quality</h3>
          <div className="settings__tiers" role="radiogroup" aria-label="Quality tier">
            {TIERS.map((tier) => (
              <label key={tier.id} className={`tier${chosenTier === tier.id ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="tier"
                  value={tier.id}
                  checked={chosenTier === tier.id}
                  onChange={() => set('tier', tier.id === autoTier ? null : tier.id)}
                />
                <span className="tier__name">
                  {tier.label}
                  {tier.id === autoTier && <span className="tier__detected">{settings.autoTier ? 'benchmarked' : 'detected'}</span>}
                </span>
                <span className="tier__hint">{tier.hint}</span>
              </label>
            ))}
          </div>
          {needsReload && (
            <p className="settings__note">
              Takes effect the next time the isle is drawn — reload to apply.
            </p>
          )}
          <label className="settings__row settings__row--slider">
            <span>Render scale · {Math.round(settings.renderScale * 100)}%</span>
            <input
              type="range" min={0.5} max={1} step={0.05}
              value={settings.renderScale}
              onChange={(e) => set('renderScale', Number(e.target.value))}
              aria-label="Render scale"
            />
          </label>
          <p className="settings__hint">
            Draws the isle with a fraction of the screen's pixels and scales it
            up. The cheapest way to hold 60 fps on integrated graphics; the
            overlay shows the true size.
          </p>
        </section>

        <section className="settings__section">
          <h3 className="settings__label">Sound</h3>
          <label className="settings__row">
            <input type="checkbox" checked={settings.sound} onChange={(e) => set('sound', e.target.checked)} />
            <span>Sea and wind</span>
          </label>
          <label className="settings__row settings__row--slider">
            <span>Volume</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={settings.volume}
              disabled={!settings.sound}
              onChange={(e) => set('volume', Number(e.target.value))}
              aria-label="Volume"
            />
          </label>
        </section>

        <section className="settings__section">
          <h3 className="settings__label">Weather</h3>
          <label className="settings__row settings__row--slider">
            <span>Cloud cover</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={settings.clouds}
              onChange={(e) => set('clouds', Number(e.target.value))}
              aria-label="Cloud cover"
            />
          </label>
          <label className="settings__row">
            <input type="checkbox" checked={settings.hud} onChange={(e) => set('hud', e.target.checked)} />
            <span>Show the performance overlay on start <kbd>F3</kbd></span>
          </label>
        </section>

        <section className="settings__section">
          <h3 className="settings__label">Templates</h3>
          <p className="settings__hint">
            Adds databases and pages to this isle. Everything a template creates
            is ordinary — edit it, delete it, or undo the whole thing.
          </p>
          <ul className="settings__packs">
            {PACKS.map((pack) => (
              <li key={pack.id}>
                <button type="button" className="pack" onClick={() => setConfirmPack(pack)}>
                  <span className="pack__name">{pack.name}</span>
                  <span className="pack__tagline">{pack.tagline}</span>
                </button>
              </li>
            ))}
          </ul>
          {confirmPack && (
            <div className="settings__confirm" role="group" aria-label={`Add ${confirmPack.name}`}>
              <span>
                Add <strong>{confirmPack.name}</strong> — {confirmPack.databases.length}{' '}
                {confirmPack.databases.length === 1 ? 'database' : 'databases'}
                {confirmPack.pages.length > 0 && ` and ${confirmPack.pages.length} ${confirmPack.pages.length === 1 ? 'page' : 'pages'}`}?
              </span>
              <span className="settings__confirm-actions">
                <button
                  type="button"
                  className="settings__button settings__button--go"
                  onClick={() => { onApplyPack(confirmPack); setConfirmPack(null); onClose() }}
                >
                  Add it
                </button>
                <button type="button" className="settings__button" onClick={() => setConfirmPack(null)}>
                  Not now
                </button>
              </span>
            </div>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__label">Your data</h3>
          <p className="settings__hint">
            {isleName || 'This isle'} lives only on this device. Export keeps a
            copy; import restores one.
          </p>
          <div className="settings__actions">
            <button type="button" className="settings__button" onClick={onExportJson}>
              Export everything (JSON)
            </button>
            <button type="button" className="settings__button" onClick={onExportMarkdown} disabled={!hasPage}>
              Export this page (Markdown)
            </button>
            <button type="button" className="settings__button" onClick={pickFile}>
              Import…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={onFile}
            />
          </div>
          {importMessage && <p className="settings__note" role="status">{importMessage}</p>}
        </section>
      </aside>
    </div>
  )
}
