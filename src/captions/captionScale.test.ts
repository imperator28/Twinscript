import { describe, expect, it } from 'vitest';
import {
  BASELINE_HISTORY_ENTRIES,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_MULTIPLIER,
  MIN_HISTORY_ENTRIES,
  MIN_HISTORY_MULTIPLIER,
  captionFontScale,
  clampHistoryEntries,
  historyFontMultiplier,
} from './captionScale';

describe('clampHistoryEntries', () => {
  it('keeps values inside the supported range', () => {
    expect(clampHistoryEntries(MIN_HISTORY_ENTRIES)).toBe(MIN_HISTORY_ENTRIES);
    expect(clampHistoryEntries(MAX_HISTORY_ENTRIES)).toBe(MAX_HISTORY_ENTRIES);
    expect(clampHistoryEntries(0)).toBe(MIN_HISTORY_ENTRIES);
    expect(clampHistoryEntries(99)).toBe(MAX_HISTORY_ENTRIES);
  });

  it('falls back to the baseline for junk rather than producing NaN', () => {
    // A NaN would propagate into a CSS variable and silently collapse the text.
    for (const junk of [undefined, null, 'abc', Number.NaN, {}]) {
      expect(clampHistoryEntries(junk)).toBe(BASELINE_HISTORY_ENTRIES);
    }
  });
});

describe('historyFontMultiplier', () => {
  it('leaves the baseline entry count unscaled', () => {
    expect(historyFontMultiplier(BASELINE_HISTORY_ENTRIES)).toBe(1);
  });

  it('enlarges text when fewer entries share the fixed height', () => {
    // This is the reported gap: reducing visible history used to leave dead space
    // instead of growing the text to fill it.
    expect(historyFontMultiplier(3)).toBeGreaterThan(1.3);
    expect(historyFontMultiplier(4)).toBeGreaterThan(1);
    expect(historyFontMultiplier(4)).toBeLessThan(historyFontMultiplier(3));
  });

  it('shrinks text when more entries must fit', () => {
    expect(historyFontMultiplier(10)).toBeLessThan(1);
    expect(historyFontMultiplier(8)).toBeLessThan(1);
    expect(historyFontMultiplier(10)).toBeLessThan(historyFontMultiplier(8));
  });

  it('is monotonic across the whole range', () => {
    // A non-monotonic curve would make the slider feel broken at some midpoint.
    let previous = Infinity;
    for (let entries = MIN_HISTORY_ENTRIES; entries <= MAX_HISTORY_ENTRIES; entries++) {
      const value = historyFontMultiplier(entries);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it('stays within its declared bounds', () => {
    for (let entries = MIN_HISTORY_ENTRIES; entries <= MAX_HISTORY_ENTRIES; entries++) {
      const value = historyFontMultiplier(entries);
      expect(value).toBeGreaterThanOrEqual(MIN_HISTORY_MULTIPLIER);
      expect(value).toBeLessThanOrEqual(MAX_HISTORY_MULTIPLIER);
    }
  });
});

describe('captionFontScale', () => {
  it('composes the operator slider with the history fit', () => {
    const baseline = captionFontScale(1, BASELINE_HISTORY_ENTRIES);
    expect(baseline).toBe(1);
    // The slider still has an effect at every history count - the camera stage
    // previously ignored it completely, which is what made the control look dead.
    expect(captionFontScale(1.4, BASELINE_HISTORY_ENTRIES)).toBeCloseTo(1.4, 3);
    expect(captionFontScale(1.4, 10)).toBeGreaterThan(captionFontScale(1, 10));
    expect(captionFontScale(0.8, 3)).toBeLessThan(captionFontScale(1.4, 3));
  });

  it('never yields a non-finite or absurd scale', () => {
    for (const junk of [undefined, null, 'abc', Number.NaN, 0, -5, 1e6]) {
      const value = captionFontScale(junk, 6);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(2.4);
    }
  });

  it('bounds the extremes even when both inputs push the same way', () => {
    const smallest = captionFontScale(0.5, MAX_HISTORY_ENTRIES);
    const largest = captionFontScale(2, MIN_HISTORY_ENTRIES);
    expect(smallest).toBeGreaterThanOrEqual(0.5);
    expect(largest).toBeLessThanOrEqual(2.4);
  });
});
