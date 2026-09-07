import { keepsakeLines, type HarvestSummary } from './seasons'
import { SEASONS } from '@/render/palette'

/**
 * The Harvest Festival.
 *
 * A quiet card that waits for you, not a modal takeover with confetti. Section
 * 11 asks for one satisfying sequence rather than a celebration that demands
 * acknowledgement, and Section 17 forbids bolting rewards onto a to-do list.
 *
 * There is no score and no comparison with last season, because a keepsake that
 * ranks you is a keepsake you stop wanting to read. It says what happened, in
 * the words the season would use.
 */

export interface HarvestCardProps {
  summary: HarvestSummary
  seasonIndex: number
  isleName: string
  onKeep: () => void
  onLater: () => void
}

export function HarvestCard({ summary, seasonIndex, isleName, onKeep, onLater }: HarvestCardProps) {
  const season = SEASONS[seasonIndex % SEASONS.length]
  const lines = keepsakeLines(summary, isleName)

  return (
    <section className="harvest" role="dialog" aria-labelledby="harvest-title" aria-modal="false">
      <p className="harvest__eyebrow">Harvest festival</p>
      <h2 className="harvest__title" id="harvest-title">
        {season.name} has turned
      </h2>

      {lines.map((line, i) => (
        <p className="harvest__line" key={i}>{line}</p>
      ))}

      <div className="harvest__actions">
        <button type="button" className="focus__button focus__button--go" onClick={onKeep}>
          Write the keepsake
        </button>
        {/*
          Declining is a real option and costs nothing - the season still turns
          when you are ready. A celebration you cannot dismiss is a demand.
        */}
        <button type="button" className="focus__button focus__button--quiet" onClick={onLater}>
          Not yet
        </button>
      </div>
    </section>
  )
}
