import { Plus, Trash2 } from 'lucide-react';

import type { DraftTerm } from './glossaryView';

// The three kinds of instruction a glossary carries, as three sections.
//
// A flat list conflated them: a do-not-translate entry has no meaningful Chinese column,
// so it rendered either as a duplicate of the English or as an empty cell, and protected
// codes were a comma-separated string in a single input with no way to see or remove one
// entry. They are different instructions and are edited differently.

interface PairSectionProps {
  drafts: DraftTerm[];
  /**
   * A row to reveal and focus, set when the operator picks Edit or Override on
   * a row in the preview list above. Without it they arrive at a collapsed
   * editor and have to hunt for the term they just clicked.
   */
  focusId?: string | null;
  disabled: boolean;
  onChange: (id: string, patch: Partial<DraftTerm>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

/** One-to-one terminology: English in, Chinese out. */
export function TermPairSection({
  drafts,
  focusId = null,
  disabled,
  onChange,
  onRemove,
  onAdd,
}: PairSectionProps) {
  return (
    <section className="glossary-section">
      <header>
        <div>
          <h3>Term pairs</h3>
          <p>Translate this English term as this Chinese term, every time.</p>
        </div>
        <button className="text-button" disabled={disabled} onClick={onAdd}>
          <Plus size={15} strokeWidth={2.5} aria-hidden="true" />
          Add pair
        </button>
      </header>
      <div className="glossary-rows">
        {drafts.map((draft, index) => (
          <div className="glossary-row glossary-row--pair" key={draft.id}>
            <input
              type="text"
              disabled={disabled}
              value={draft.en}
              aria-label={`English term ${index + 1}`}
              placeholder="wall thickness"
              ref={(node) => {
                // Scrolled as well as focused: the row can be well below the
                // fold in a long glossary, and a focused input the operator
                // cannot see is the same as no focus at all.
                if (node && focusId && draft.id === focusId) {
                  node.focus();
                  node.scrollIntoView({ block: 'center' });
                }
              }}
              onChange={(event) => onChange(draft.id, { en: event.target.value })}
            />
            <span className="glossary-row__arrow" aria-hidden="true">→</span>
            <input
              type="text"
              lang="zh-Hans"
              disabled={disabled}
              value={draft.zh}
              aria-label={`Chinese term ${index + 1}`}
              placeholder="壁厚"
              onChange={(event) => onChange(draft.id, { zh: event.target.value })}
            />
            <button
              className="text-button glossary-row__remove"
              // The trailing blank row has nothing to remove, and removing the only row
              // would leave no way to type anything.
              disabled={disabled || (!draft.en && !draft.zh)}
              aria-label={`Remove term pair ${index + 1}`}
              onClick={() => onRemove(draft.id)}
            >
              <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

interface LiteralSectionProps {
  drafts: DraftTerm[];
  focusId?: string | null;
  disabled: boolean;
  onChange: (id: string, patch: Partial<DraftTerm>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

/** Phrases that must appear untranslated in both captions. One column, not two. */
export function LiteralSection({
  drafts,
  focusId = null,
  disabled,
  onChange,
  onRemove,
  onAdd,
}: LiteralSectionProps) {
  return (
    <section className="glossary-section">
      <header>
        <div>
          <h3>Never translate</h3>
          <p>Phrases that stay in English in both captions.</p>
        </div>
        <button className="text-button" disabled={disabled} onClick={onAdd}>
          <Plus size={15} strokeWidth={2.5} aria-hidden="true" />
          Add phrase
        </button>
      </header>
      <div className="glossary-rows">
        {drafts.map((draft, index) => (
          <div className="glossary-row glossary-row--single" key={draft.id}>
            <input
              type="text"
              disabled={disabled}
              value={draft.en}
              aria-label={`Never-translate phrase ${index + 1}`}
              placeholder="Design for Six Sigma"
              ref={(node) => {
                // Scrolled as well as focused: the row can be well below the
                // fold in a long glossary, and a focused input the operator
                // cannot see is the same as no focus at all.
                if (node && focusId && draft.id === focusId) {
                  node.focus();
                  node.scrollIntoView({ block: 'center' });
                }
              }}
              onChange={(event) => onChange(draft.id, { en: event.target.value })}
            />
            <button
              className="text-button glossary-row__remove"
              disabled={disabled || !draft.en}
              aria-label={`Remove phrase ${index + 1}`}
              onClick={() => onRemove(draft.id)}
            >
              <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

interface ContextSectionProps {
  entries: string[];
  disabled: boolean;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

/**
 * Contextual knowledge: who and what is being discussed.
 *
 * Rows rather than a textarea for the same reason as the others - a textarea gives no
 * per-entry remove, no count, and no feedback until the whole blob is saved.
 */
export function ContextSection({
  entries,
  disabled,
  onChange,
  onRemove,
  onAdd,
}: ContextSectionProps) {
  return (
    <section className="glossary-section">
      <header>
        <div>
          <h3>Meeting context</h3>
          <p>
            People, projects and sites. Names spelled here are transcribed rather than
            guessed at phonetically.
          </p>
        </div>
        <button className="text-button" disabled={disabled} onClick={onAdd}>
          <Plus size={15} strokeWidth={2.5} aria-hidden="true" />
          Add context
        </button>
      </header>
      <div className="glossary-rows">
        {entries.map((entry, index) => (
          <div className="glossary-row glossary-row--single" key={`context-${index}`}>
            <input
              type="text"
              disabled={disabled}
              value={entry}
              aria-label={`Context entry ${index + 1}`}
              placeholder="Lily Chen, quality lead at the Suzhou plant"
              onChange={(event) => onChange(index, event.target.value)}
            />
            <button
              className="text-button glossary-row__remove"
              disabled={disabled || !entry}
              aria-label={`Remove context entry ${index + 1}`}
              onClick={() => onRemove(index)}
            >
              <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

interface TokenSectionProps {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

/**
 * Protected codes. Still one comma-separated field, because these are short tokens
 * typed in runs ("T1, T2, ABC-123") and a row per token would be more work, not less -
 * but the parsed result is previewed as chips so what was understood is visible.
 */
export function TokenSection({ value, disabled, onChange }: TokenSectionProps) {
  const parsed = value
    .split(/[,\n;]/)
    .map((token) => token.trim())
    .filter(Boolean);
  return (
    <section className="glossary-section">
      <header>
        <div>
          <h3>Protected codes</h3>
          <p>Part numbers and gate names, kept literal in both languages.</p>
        </div>
      </header>
      <input
        id="custom-protected-tokens"
        type="text"
        disabled={disabled}
        value={value}
        aria-label="Protected codes"
        placeholder="Project Falcon, ABC-123, Gate 4"
        onChange={(event) => onChange(event.target.value)}
      />
      {parsed.length > 0 && (
        <div className="glossary-tags" aria-label="Protected codes preview">
          {parsed.map((token, index) => (
            <span key={`${token}-${index}`}>{token}</span>
          ))}
        </div>
      )}
    </section>
  );
}
