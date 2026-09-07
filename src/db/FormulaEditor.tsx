import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '@/state/store'
import { UpdateProperty } from '@/state/databaseCommands'
import type { Database, PropertyDef } from '@/state/database'
import { validateFormula } from '@/formula/graph'
import { FUNCTION_NAMES } from '@/formula/evaluate'

/**
 * The formula editor.
 *
 * Validation runs on every keystroke and the Save button stays disabled while
 * the formula is invalid, so a cycle is refused *at edit time* rather than
 * discovered later by the table hanging. That is the whole point of doing
 * cycle detection against the graph an edit would create rather than the graph
 * that exists: nothing invalid ever reaches the store.
 *
 * The error message is the feature. "Unexpected token" would be accurate and
 * useless; naming the loop, or the property that does not exist, is what lets
 * someone fix it without reading documentation.
 */

export interface FormulaEditorProps {
  database: Database
  property: PropertyDef
  onDone(): void
}

export function FormulaEditor({ database, property, onDone }: FormulaEditorProps) {
  const dispatch = useWorkspaceStore((s) => s.dispatch)
  const [source, setSource] = useState(property.formula ?? '')

  const result = useMemo(
    () => (source.trim() ? validateFormula(database, property.id, source) : { ok: true as const }),
    [database, property.id, source],
  )

  const save = () => {
    if (!result.ok) return
    dispatch(new UpdateProperty(database.id, property.id, { formula: source }))
    onDone()
  }

  return (
    <div className="formula" role="region" aria-label={`Formula for ${property.name}`}>
      <label className="formula__label" htmlFor={`formula-${property.id}`}>
        {property.name}
      </label>

      <textarea
        id={`formula-${property.id}`}
        className={`formula__input${result.ok ? '' : ' is-invalid'}`}
        value={source}
        rows={3}
        spellCheck={false}
        autoFocus
        placeholder={'prop("Estimate") * 2'}
        aria-invalid={!result.ok}
        aria-describedby={`formula-status-${property.id}`}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          // Enter saves, Shift+Enter breaks the line - formulas get long.
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
          if (e.key === 'Escape') { e.preventDefault(); onDone() }
        }}
      />

      <p
        id={`formula-status-${property.id}`}
        className={`formula__status${result.ok ? '' : ' is-invalid'}`}
        role={result.ok ? undefined : 'alert'}
      >
        {result.ok
          ? source.trim() ? 'Looks good.' : 'Reference a column with prop("Name").'
          : result.message}
      </p>

      <details className="formula__help">
        <summary>Functions</summary>
        <p className="formula__functions">{FUNCTION_NAMES.join(' · ')}</p>
        <p className="formula__hint">
          Columns: <code>prop(&quot;Estimate&quot;)</code>. Operators:
          {' '}<code>+ - * / %</code>, <code>== != &lt; &gt; &lt;= &gt;=</code>,
          {' '}<code>and or not</code>.
        </p>
      </details>

      <div className="formula__actions">
        <button type="button" className="panel__add" onClick={save} disabled={!result.ok}>
          Save
        </button>
        <button type="button" className="panel__remove panel__cancel" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}
