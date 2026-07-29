import { describe, expect, it } from 'vitest';
import {
  SCREENING_CORPUS,
  SCREENING_CORPUS_SUMMARY,
} from './screeningCorpus';

describe('phase 1 screening corpus', () => {
  it('meets the PRD screening size and coverage floors', () => {
    expect(SCREENING_CORPUS_SUMMARY.total).toBeGreaterThanOrEqual(200);
    expect(
      SCREENING_CORPUS_SUMMARY.codeSwitch / SCREENING_CORPUS_SUMMARY.total,
    ).toBeGreaterThanOrEqual(0.25);
    expect(SCREENING_CORPUS_SUMMARY.critical).toBeGreaterThanOrEqual(50);
    expect(SCREENING_CORPUS_SUMMARY.microphone).toBeGreaterThan(0);
    expect(SCREENING_CORPUS_SUMMARY.system).toBeGreaterThan(0);
    for (const languageClass of [
      'en',
      'zh',
      'mixed-between',
      'mixed-inline',
    ] as const) {
      const channels = new Set(
        SCREENING_CORPUS.filter(
          (item) => item.languageClass === languageClass,
        ).map((item) => item.sourceChannel),
      );
      expect(channels).toEqual(new Set(['microphone', 'system']));
    }
  });

  it('has stable unique IDs and complete bilingual references', () => {
    expect(new Set(SCREENING_CORPUS.map((item) => item.id)).size).toBe(
      SCREENING_CORPUS.length,
    );
    for (const item of SCREENING_CORPUS) {
      expect(item.sourceText.trim()).not.toBe('');
      expect(item.englishReference.trim()).not.toBe('');
      expect(item.chineseReference.trim()).not.toBe('');
      expect(item.scripted).toBe(true);
    }
  });
});
