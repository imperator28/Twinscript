import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DELAY_PROFILE,
  DELAY_OPTIONS,
  delayIndex,
  delayOption,
  delayProfileAt,
} from './captionDelay';

describe('DELAY_OPTIONS', () => {
  it('runs fastest to steadiest, so a slider reads left as sooner', () => {
    expect(DELAY_OPTIONS.map((option) => option.profile)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('states a consequence for every option, in both directions', () => {
    // The old dropdown said "Fastest / Fast / Stable" and named no cost, which is a choice
    // presented as free - so the answer was always Fastest.
    for (const option of DELAY_OPTIONS) {
      expect(option.detail.length).toBeGreaterThan(40);
      expect(option.detail).toMatch(/rewrit|wait|corrected|live/i);
    }
  });

  it('labels the behaviour rather than the setting', () => {
    expect(DELAY_OPTIONS.map((option) => option.label)).toEqual([
      'Fastest',
      'Fast',
      'Balanced',
      'Careful',
      'Most accurate',
    ]);
  });

  it('uses the profile names the transcription API expects', () => {
    // These go straight through to OpenAI's `delay` parameter; a renamed label must not
    // change the wire value.
    for (const option of DELAY_OPTIONS) {
      // The exact set the API named when it rejected 'default'.
      expect(['minimal', 'low', 'medium', 'high', 'xhigh']).toContain(option.profile);
    }
  });
});

describe('delayIndex', () => {
  it('maps each profile to its slider position', () => {
    expect(delayIndex('minimal')).toBe(0);
    expect(delayIndex('low')).toBe(1);
    expect(delayIndex('medium')).toBe(2);
    expect(delayIndex('xhigh')).toBe(4);
  });

  it('falls back to the shipped default, not to position zero', () => {
    // Position zero is Fastest, the option with the most visible downside. An unreadable
    // stored value must not quietly move an operator onto it.
    const fallback = delayIndex(DEFAULT_DELAY_PROFILE);
    expect(delayIndex(undefined)).toBe(fallback);
    expect(delayIndex(null)).toBe(fallback);
    expect(delayIndex('turbo')).toBe(fallback);
    // The value that shipped and was rejected by the API resolves to the default too.
    expect(delayIndex('default')).toBe(fallback);
    expect(fallback).not.toBe(0);
  });
});

describe('delayProfileAt', () => {
  it('maps a slider position back to its profile', () => {
    expect(delayProfileAt(0)).toBe('minimal');
    expect(delayProfileAt(1)).toBe('low');
    expect(delayProfileAt(4)).toBe('xhigh');
  });

  it('clamps rather than returning undefined at the edges', () => {
    expect(delayProfileAt(-5)).toBe('minimal');
    expect(delayProfileAt(99)).toBe('xhigh');
  });

  it('rounds a fractional position', () => {
    expect(delayProfileAt(1.4)).toBe('low');
    expect(delayProfileAt(1.6)).toBe('medium');
  });

  it('round-trips with delayIndex', () => {
    for (const option of DELAY_OPTIONS) {
      expect(delayProfileAt(delayIndex(option.profile))).toBe(option.profile);
    }
  });
});

describe('delayOption', () => {
  it('returns the option for display', () => {
    expect(delayOption('xhigh').label).toBe('Most accurate');
  });

  it('never returns undefined for an unknown value', () => {
    expect(delayOption('nonsense').profile).toBe(DEFAULT_DELAY_PROFILE);
  });
});

describe('liveSafe', () => {
  it('marks only the settings where captions still track the conversation', () => {
    // The five values came from the API's own list of what it accepts, which says nothing
    // about whether they are usable for live captioning. At the top of the range the
    // captions no longer belong to the sentence being spoken.
    expect(
      DELAY_OPTIONS.filter((option) => option.liveSafe).map((o) => o.profile),
    ).toEqual(['minimal', 'low', 'medium']);
    expect(
      DELAY_OPTIONS.filter((option) => !option.liveSafe).map((o) => o.profile),
    ).toEqual(['high', 'xhigh']);
  });

  it('keeps the shipped default inside the live-safe range', () => {
    expect(delayOption(DEFAULT_DELAY_PROFILE).liveSafe).toBe(true);
  });

  it('keeps the unsafe settings at the far end, so the slider degrades in one direction', () => {
    const firstUnsafe = DELAY_OPTIONS.findIndex((option) => !option.liveSafe);
    expect(
      DELAY_OPTIONS.slice(firstUnsafe).every((option) => !option.liveSafe),
    ).toBe(true);
  });
});
