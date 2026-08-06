// Searching and editing the glossary.
//
// The Settings card reported "138 built-in terms · 31 protected tokens" and offered a
// raw textarea for overrides. An operator could not see whether a term was already
// covered, what its built-in Chinese rendering was, or whether their own override had
// taken effect - and a textarea gives no feedback at all until the whole blob is saved.
//
// Kept separate from the component so the matching and parsing rules are testable
// without rendering, and so the editor and the viewer cannot disagree about what a row
// means.

export type GlossarySource = 'builtin' | 'custom';

export interface EffectiveGlossaryTerm {
  en: string;
  zh: string;
  doNotTranslate: boolean;
  source: GlossarySource;
}

export interface EffectiveGlossary {
  configurationId: string;
  protectedTokens: string[];
  storedCount: number;
  terms: EffectiveGlossaryTerm[];
}

/** A row in the in-place editor. `id` is local only, to key React rows stably. */
export interface DraftTerm {
  id: string;
  en: string;
  zh: string;
  doNotTranslate: boolean;
}

/**
 * Substring match across both languages, case-insensitive for Latin text.
 *
 * Chinese has no case, and `toLowerCase` is a no-op on it, so one lowercased comparison
 * serves both sides. Matching the Chinese column matters as much as the English: an
 * operator checking whether the app already knows a supplier's term usually has the
 * Chinese in front of them, not the English.
 */
export function matchesQuery(term: EffectiveGlossaryTerm, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    term.en.toLowerCase().includes(needle) ||
    term.zh.toLowerCase().includes(needle)
  );
}

/**
 * Filter, then cap what is rendered.
 *
 * The effective glossary runs to a few hundred rows and this list lives inside a
 * scrolling settings page; rendering all of them makes every keystroke in the search box
 * re-layout the whole card. The cap is reported rather than silently applied so the
 * operator knows the list is truncated and can narrow the query.
 */
export function filterTerms(
  terms: EffectiveGlossaryTerm[],
  query: string,
  { limit = 40 }: { limit?: number } = {},
): { visible: EffectiveGlossaryTerm[]; matchCount: number; truncated: number } {
  const matches = terms.filter((term) => matchesQuery(term, query));
  const visible = matches.slice(0, limit);
  return {
    visible,
    matchCount: matches.length,
    truncated: Math.max(0, matches.length - visible.length),
  };
}

let draftCounter = 0;

/** A blank editor row. */
export function blankDraft(): DraftTerm {
  draftCounter += 1;
  return { id: `draft-${draftCounter}`, en: '', zh: '', doNotTranslate: false };
}

/**
 * Turn stored custom terms into editor rows. Always leaves one empty row at the end so
 * adding a term needs no separate "add" click.
 */
export function draftsFromTerms(
  terms: Array<{ en: string; zh: string; doNotTranslate?: boolean }> | null | undefined,
): DraftTerm[] {
  const rows = (terms || []).map((term) => ({
    ...blankDraft(),
    en: term.en,
    zh: term.zh,
    doNotTranslate: Boolean(term.doNotTranslate),
  }));
  return [...rows, blankDraft()];
}

/**
 * Editor rows back to storable terms.
 *
 * A row with neither side filled is the trailing blank and is dropped silently. A row
 * with only one side is dropped too, but reported, because "boss = " is a half-typed
 * entry rather than an instruction and saving it would quietly lose the operator's work.
 * `doNotTranslate` rows are the exception: an English phrase that must stay in English
 * needs no Chinese column at all.
 */
export function draftsToTerms(drafts: DraftTerm[]): {
  terms: Array<{ en: string; zh: string; doNotTranslate: boolean }>;
  incomplete: number;
} {
  const terms: Array<{ en: string; zh: string; doNotTranslate: boolean }> = [];
  let incomplete = 0;
  for (const draft of drafts) {
    const en = draft.en.trim();
    const zh = draft.zh.trim();
    if (!en && !zh) continue;
    if (draft.doNotTranslate && en) {
      terms.push({ en, zh: zh || en, doNotTranslate: true });
      continue;
    }
    if (!en || !zh) {
      incomplete += 1;
      continue;
    }
    terms.push({ en, zh, doNotTranslate: false });
  }
  return { terms, incomplete };
}

/**
 * Context entries - names, projects, sites - one per line.
 *
 * These are not translation pairs. They tell the model who and what is being discussed
 * so a supplier's name is transcribed rather than guessed at phonetically, which is the
 * single most common way a bilingual engineering transcript goes wrong.
 */
export function parseContextNotes(raw: string): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(value);
  }
  return notes;
}

export function formatContextNotes(notes: string[] | null | undefined): string {
  return (notes || []).join('\n');
}
