import { describe, expect, it } from 'vitest';

import {
  draftSections,
  partitionGlossary,
  blankDraft,
  draftsFromTerms,
  draftsToTerms,
  filterTerms,
  formatContextNotes,
  matchesQuery,
  parseContextNotes,
  type EffectiveGlossaryTerm,
} from './glossaryView';

const term = (
  en: string,
  zh: string,
  extra: Partial<EffectiveGlossaryTerm> = {},
): EffectiveGlossaryTerm => ({
  en,
  zh,
  doNotTranslate: false,
  source: 'builtin',
  active: true,
  ...extra,
});

describe('matchesQuery', () => {
  const boss = term('boss', '凸台');

  it('matches an empty query so the unfiltered list shows everything', () => {
    expect(matchesQuery(boss, '')).toBe(true);
    expect(matchesQuery(boss, '   ')).toBe(true);
  });

  it('matches substrings, not just prefixes', () => {
    expect(matchesQuery(term('wall thickness', '壁厚'), 'thick')).toBe(true);
  });

  it('ignores case on the English side', () => {
    expect(matchesQuery(boss, 'BOSS')).toBe(true);
  });

  it('searches the Chinese column too', () => {
    // An operator checking whether a supplier's term is already known usually has the
    // Chinese in front of them, not the English.
    expect(matchesQuery(boss, '凸台')).toBe(true);
    expect(matchesQuery(boss, '凸')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(matchesQuery(boss, 'gasket')).toBe(false);
  });
});

describe('filterTerms', () => {
  const many = Array.from({ length: 100 }, (_, i) => term(`term-${i}`, `词-${i}`));

  it('caps what is rendered and reports the remainder', () => {
    // Rendering hundreds of rows makes every keystroke in the search box re-layout the
    // whole card, so the cap is real - but it is reported, not silent.
    const result = filterTerms(many, '', { limit: 10 });
    expect(result.visible).toHaveLength(10);
    expect(result.matchCount).toBe(100);
    expect(result.truncated).toBe(90);
  });

  it('reports nothing truncated when everything fits', () => {
    const result = filterTerms(many.slice(0, 5), '', { limit: 10 });
    expect(result.truncated).toBe(0);
    expect(result.matchCount).toBe(5);
  });

  it('narrows to matches before capping', () => {
    const result = filterTerms([...many, term('gasket', '垫片')], 'gasket');
    expect(result.matchCount).toBe(1);
    expect(result.visible[0].en).toBe('gasket');
  });

  it('reports zero matches rather than falling back to everything', () => {
    const result = filterTerms(many, 'nothing-matches-this');
    expect(result.matchCount).toBe(0);
    expect(result.visible).toEqual([]);
  });
});

describe('draftsFromTerms', () => {
  it('always leaves a trailing blank row so adding needs no extra click', () => {
    const drafts = draftsFromTerms([{ en: 'boss', zh: '凸台' }]);
    expect(drafts).toHaveLength(2);
    expect(drafts[1].en).toBe('');
  });

  it('produces a single blank row for an empty glossary', () => {
    expect(draftsFromTerms([])).toHaveLength(1);
    expect(draftsFromTerms(null)).toHaveLength(1);
    expect(draftsFromTerms(undefined)).toHaveLength(1);
  });

  it('gives every row a distinct id so React keys stay stable', () => {
    const drafts = draftsFromTerms([
      { en: 'a', zh: '1' },
      { en: 'b', zh: '2' },
    ]);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(drafts.length);
  });

  it('carries doNotTranslate through', () => {
    const drafts = draftsFromTerms([{ en: 'EVT', zh: 'EVT', doNotTranslate: true }]);
    expect(drafts[0].doNotTranslate).toBe(true);
  });
});

describe('draftsToTerms', () => {
  it('drops the trailing blank row silently', () => {
    const { terms, incomplete } = draftsToTerms([
      { ...blankDraft(), en: 'boss', zh: '凸台' },
      blankDraft(),
    ]);
    expect(terms).toEqual([{ en: 'boss', zh: '凸台', doNotTranslate: false }]);
    expect(incomplete).toBe(0);
  });

  it('reports a half-typed row instead of saving or discarding it quietly', () => {
    // "boss = " is unfinished work, not an instruction. Saving it would corrupt the
    // glossary; dropping it without a word would lose what the operator typed.
    const { terms, incomplete } = draftsToTerms([
      { ...blankDraft(), en: 'boss', zh: '' },
      { ...blankDraft(), en: '', zh: '垫片' },
    ]);
    expect(terms).toEqual([]);
    expect(incomplete).toBe(2);
  });

  it('accepts a do-not-translate row with no Chinese column', () => {
    // An English phrase that must stay in English needs no translation to be complete.
    const { terms, incomplete } = draftsToTerms([
      { ...blankDraft(), en: 'Project Falcon', zh: '', doNotTranslate: true },
    ]);
    expect(terms).toEqual([
      { en: 'Project Falcon', zh: 'Project Falcon', doNotTranslate: true },
    ]);
    expect(incomplete).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    const { terms } = draftsToTerms([
      { ...blankDraft(), en: '  boss  ', zh: '  凸台 ' },
    ]);
    expect(terms[0]).toEqual({ en: 'boss', zh: '凸台', doNotTranslate: false });
  });

  it('treats a whitespace-only row as blank, not as incomplete', () => {
    const { terms, incomplete } = draftsToTerms([
      { ...blankDraft(), en: '   ', zh: '  ' },
    ]);
    expect(terms).toEqual([]);
    expect(incomplete).toBe(0);
  });
});

describe('parseContextNotes', () => {
  it('splits on newlines and trims', () => {
    expect(parseContextNotes('Lily Chen\n  Falcon tooling  \n')).toEqual([
      'Lily Chen',
      'Falcon tooling',
    ]);
  });

  it('drops blank lines', () => {
    expect(parseContextNotes('a\n\n\nb')).toEqual(['a', 'b']);
  });

  it('removes duplicates case-insensitively, keeping the first spelling', () => {
    // A name repeated with different capitalisation is one piece of context, and sending
    // it twice spends prompt budget for nothing.
    expect(parseContextNotes('Lily Chen\nlily chen')).toEqual(['Lily Chen']);
  });

  it('handles CRLF, which is what a Windows paste carries', () => {
    expect(parseContextNotes('a\r\nb')).toEqual(['a', 'b']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseContextNotes('')).toEqual([]);
    expect(parseContextNotes('   \n  ')).toEqual([]);
  });
});

describe('formatContextNotes', () => {
  it('round-trips through the parser', () => {
    const notes = ['Lily Chen', 'Falcon tooling', 'Suzhou site'];
    expect(parseContextNotes(formatContextNotes(notes))).toEqual(notes);
  });

  it('renders an empty editor for no notes', () => {
    expect(formatContextNotes([])).toBe('');
    expect(formatContextNotes(null)).toBe('');
    expect(formatContextNotes(undefined)).toBe('');
  });
});

describe('partitionGlossary', () => {
  const glossary = {
    configurationId: 'universal-engineering',
    protectedTokens: ['T1', 'EVT'],
    storedCount: 3,
    activeLimit: 40,
    terms: [
      term('boss', '凸台'),
      term('wall thickness', '壁厚'),
      term('Design for Six Sigma', 'Design for Six Sigma', { doNotTranslate: true }),
    ],
  };

  it('separates pairs from never-translate phrases', () => {
    // A never-translate entry has no meaningful Chinese column, so rendering it in a
    // two-column pair list showed either a duplicate of the English or an empty cell.
    const { pairs, literal } = partitionGlossary(glossary);
    expect(pairs.map((t) => t.en)).toEqual(['boss', 'wall thickness']);
    expect(literal.map((t) => t.en)).toEqual(['Design for Six Sigma']);
  });

  it('carries protected tokens through as their own category', () => {
    expect(partitionGlossary(glossary).tokens).toEqual(['T1', 'EVT']);
  });

  it('returns empty sections for no glossary', () => {
    expect(partitionGlossary(null)).toEqual({ pairs: [], literal: [], tokens: [] });
  });
});

describe('draftSections', () => {
  it('routes each stored term to its own section', () => {
    const { pairs, literal } = draftSections([
      { en: 'boss', zh: '凸台' },
      { en: 'EVT', zh: 'EVT', doNotTranslate: true },
    ]);
    // Each section ends in a blank row, so neither is ever a dead end.
    expect(pairs.map((d) => d.en)).toEqual(['boss', '']);
    expect(literal.map((d) => d.en)).toEqual(['EVT', '']);
  });

  it('marks literal rows so they cannot be recombined as pairs', () => {
    const { literal } = draftSections([{ en: 'EVT', zh: 'EVT', doNotTranslate: true }]);
    expect(literal.every((d) => d.doNotTranslate)).toBe(true);
  });

  it('gives a blank glossary one empty row per section', () => {
    const { pairs, literal } = draftSections([]);
    expect(pairs).toHaveLength(1);
    expect(literal).toHaveLength(1);
  });

  it('round-trips through draftsToTerms without changing categories', () => {
    const stored = [
      { en: 'boss', zh: '凸台', doNotTranslate: false },
      { en: 'EVT', zh: 'EVT', doNotTranslate: true },
    ];
    const { pairs, literal } = draftSections(stored);
    const { terms, incomplete } = draftsToTerms([...pairs, ...literal]);
    expect(incomplete).toBe(0);
    expect(terms).toEqual(stored);
  });
});
